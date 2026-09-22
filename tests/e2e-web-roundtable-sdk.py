"""Independent interoperability check using the installed official Python MCP SDK.

Reads/replays an EXISTING finished request; never creates a new website question.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--task', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    params = StdioServerParameters(command='node', args=[str(root / 'core/web-roundtable/server.js')],
                                  env={**os.environ, 'AI_HUB_WEB_DATA_DIR': args.data_dir})

    def result(value):
        if value.isError:
            raise RuntimeError(value.content[0].text)
        return json.loads(value.content[0].text)

    async def client():
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                initialized = await session.initialize()
                tools = await session.list_tools()
                assert 'roundtable_start' in [t.name for t in tools.tools]
                prior = result(await session.call_tool('roundtable_get', {'task_id': args.task}))
                assert prior['state'] == 'succeeded'
                replay = result(await session.call_tool('roundtable_start',
                    {'request_id': prior['requestId'], **prior['input']}))
                assert replay['id'] == args.task and replay['state'] == 'succeeded'
                exported = result(await session.call_tool('roundtable_export', {'task_id': args.task}))
                assert Path(exported['path']).is_file()
                return {'task': replay['id'], 'state': replay['state'],
                        'protocol': initialized.protocolVersion, 'tools': len(tools.tools),
                        'children': {r['provider']: r['id'] for r in prior['rounds'][0]['results']}}

    proof = await asyncio.gather(client(), client())
    children = []
    for provider, task_id in proof[0]['children'].items():
        child_params = StdioServerParameters(command='node',
            args=[str(root / 'core/web-roundtable/provider-server.js'), provider], env=params.env)
        async with stdio_client(child_params) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                listed = await session.list_tools()
                assert 'web_ask' in [t.name for t in listed.tools]
                reply = result(await session.call_tool('web_get', {'task_id': task_id}))
                assert reply['state'] == 'succeeded' and reply['answer']
                children.append({'provider': provider, 'task': task_id, 'standalone': True})
    output = root / 'artifacts/web-roundtable/sdk-verification.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'officialPythonSdk': True, 'clients': proof, 'standaloneProviders': children,
                                 'newWebsiteQuestions': 0}, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS: official Python MCP SDK, two independent clients, initialize/list/call/export and deduplicated replay')
    print(output)


if __name__ == '__main__':
    asyncio.run(main())
