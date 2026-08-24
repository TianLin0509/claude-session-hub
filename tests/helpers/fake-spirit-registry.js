'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createFakeSpiritRegistry(root) {
  const cliDir = path.join(root, 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const script = String.raw`import hashlib
import json
import sys

args = sys.argv[1:]
commands = {'list', 'manifest', 'prepare', 'validate'}
command = next((item for item in args if item in commands), '')

def digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()

if command == 'list':
    output = {
        'constitution_id': 'chuxin.spirit.constitution.v1',
        'spirits': [
            {'spirit_id': 'buffett.mature.v1'},
            {'spirit_id': 'livermore.trend.v1'},
        ],
    }
elif command == 'manifest':
    spirit_id = args[args.index('--spirit') + 1] if '--spirit' in args else ''
    output = {'spirit_id': spirit_id, 'manifest_hash': digest(spirit_id), 'rules': []}
elif command == 'prepare':
    payload = json.load(sys.stdin)
    spirit_ids = payload.get('spirit_ids') or ['buffett.mature.v1', 'livermore.trend.v1']
    evidence_hash = digest(payload.get('evidence') or {})
    manifest_hash = digest(spirit_ids)
    rendered = '[B01] 价值镜头\n[L01] 趋势镜头\n' + str(payload.get('question') or '')
    output = {
        'packet_id': digest([spirit_ids, evidence_hash])[:16],
        'spirit_ids': spirit_ids,
        'mandate': payload.get('mandate'),
        'manifest_hash': manifest_hash,
        'evidence_snapshot_hash': evidence_hash,
        'prompt_hash': digest(rendered),
        'rendered_prompt': rendered,
    }
elif command == 'validate':
    payload = json.load(sys.stdin)
    output = {'valid': True, 'packet_id': (payload.get('packet') or {}).get('packet_id')}
else:
    print(json.dumps({'error': 'unknown command'}), file=sys.stderr)
    sys.exit(2)

print(json.dumps(output, ensure_ascii=False))
`;
  fs.writeFileSync(path.join(cliDir, 'spirit.py'), script, 'utf8');
  return root;
}

module.exports = { createFakeSpiritRegistry };
