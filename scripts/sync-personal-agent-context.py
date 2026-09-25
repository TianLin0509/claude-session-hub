"""Explicit, backed-up migration of one person's native context settings.

Default is --check. Only --apply writes. Credentials and history are never
merged. Run again to propagate subsequent edits to the chosen source account.
"""
import argparse,copy,datetime,hashlib,json,os,pathlib,re,tomllib

def sha(b):return hashlib.sha256(b).hexdigest()
def toml(v):
    def key(k):
        return k if re.fullmatch(r'[A-Za-z0-9_-]+',k) else json.dumps(k,ensure_ascii=False)
    def scalar(x):
        if isinstance(x,bool):return 'true' if x else 'false'
        if isinstance(x,str):return json.dumps(x,ensure_ascii=False)
        if isinstance(x,(int,float)):return repr(x)
        if isinstance(x,list):return '['+', '.join(scalar(y) for y in x)+']'
        if isinstance(x,dict):return '{'+', '.join(json.dumps(k)+' = '+scalar(y) for k,y in x.items())+'}'
        if isinstance(x,(datetime.datetime,datetime.date,datetime.time)):return x.isoformat()
        raise TypeError(type(x).__name__)
    lines=[]
    def table(d,keys):
        # The installed Hub recognizes literal project keys when pretrusting
        # cwd. Preserve that spelling, or it appends duplicate TOML tables.
        if len(keys)==2 and keys[0]=='projects' and "'" not in keys[1] and '\n' not in keys[1] and '\r' not in keys[1]:
            lines.append("[projects.'"+keys[1]+"']")
        elif keys:lines.append('['+'.'.join(key(k) for k in keys)+']')
        for k,x in d.items():
            if not isinstance(x,dict):lines.append(key(k)+' = '+scalar(x))
        lines.append('')
        for k,x in d.items():
            if isinstance(x,dict):table(x,keys+[k])
    table(v,[]);s='\n'.join(lines);assert tomllib.loads(s)==v;return s.encode('utf-8')

def plan(home,accounts,workspace):
    changes={}
    def put(p,b):
        p=pathlib.Path(p);old=p.read_bytes() if p.exists() else None
        if old!=b:changes[str(p)]=(old,b)
    configs=[tomllib.loads((p/'config.toml').read_text(encoding='utf-8-sig')) for p in accounts]
    source=copy.deepcopy(configs[0])
    keys=['model','model_reasoning_effort','model_reasoning_summary','approval_policy','sandbox_mode','service_tier','features','notice','tui','windows','mcp_servers','plugins','marketplaces','skills']
    projects={}
    for c in configs:
        for k,v in c.get('projects',{}).items():
            if k in projects and projects[k]!=v:raise ValueError('Conflicting project trust settings: '+k)
            projects[k]=v
    common=None
    for p,c in zip(accounts,configs):
        new=copy.deepcopy(c)
        for k in keys:
            if k in source:new[k]=copy.deepcopy(source[k])
            else:new.pop(k,None)
        new['projects']=copy.deepcopy(projects)
        new['project_root_markers']=['.git','.vibe-root']
        # Keep native generation/storage available; use one common curated
        # personal context instead of account-specific automatic summaries.
        new.setdefault('features',{})['memories']=True
        new.setdefault('memories',{})['use_memories']=False
        put(p/'config.toml',toml(new))
        if common is None:common={k:copy.deepcopy(new[k]) for k in keys+['project_root_markers','memories'] if k in new}
    policy={'version':1,'codexDefaults':common}
    hooks=accounts[0]/'hooks.json'
    if hooks.exists():
        raw_hooks=hooks.read_bytes();json.loads(raw_hooks.decode('utf-8-sig'))
        policy['codexHooks']=json.loads(raw_hooks.decode('utf-8-sig'))
        for p in accounts:put(p/'hooks.json',raw_hooks)
    # Equivalent workspace rules must be byte-identical for engines (DSH)
    # whose native deduplication does not strip descriptive comments.
    files=[workspace/n for n in ['AGENTS.md','CLAUDE.md','GEMINI.md']]
    raws=[p.read_text(encoding='utf-8-sig') for p in files]
    norm=lambda s:re.sub(r'<!--[\s\S]*?-->','',s).replace('\r\n','\n').strip()
    if len(set(map(norm,raws)))!=1:raise ValueError('Workspace rules have distinct instructions; manual review required')
    header='<!-- 工作根规则：Codex / Kimi / Qwen / ZCode 读 AGENTS.md；Claude 读 CLAUDE.md；Gemini 读 GEMINI.md。\n     三份文件保持逐字一致；DSH 原生可据此去重。全局个人规则不写在这里。 -->'
    text=re.sub(r'<!--[\s\S]*?-->',lambda _:header,raws[0],count=1).replace('\r\n','\n')
    for p in files:put(p,text.encode('utf-8'))
    root=home/'.agents';src=root/'USER_CONTEXT.md';text=src.read_text(encoding='utf-8-sig')
    old='- 需要 Codex 历史时，先检索'
    if '账号只用于额度' not in text:
        text=text.replace('## 记忆与加载\n','## 记忆与加载\n\n- 账号只用于额度与鉴权；身份、协作规则和记忆查阅入口以这份共同规则为准。Codex 各账号的原生历史摘要保留按需检索，不在启动时自动叠加成不同的个人印象。\n')
    raw=text.encode('utf-8');put(src,raw)
    manifest_path=root/'user-context-targets.json';manifest=json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    for row in manifest['targets']:
        p=pathlib.Path(row['path']);existing=p.read_bytes() if p.exists() else None
        if existing is not None and sha(existing)!=row['last_sha256'] and existing!=raw:raise ValueError('Independent global rule edit: '+str(p))
        put(p,raw);row['last_sha256']=sha(raw)
    # Seed the real native global roots too; future ACP homes are seeded by Hub.
    for folder,name,kind in [('.dsh','AGENTS.md','deepseek-acp'),('.qwen','QWEN.md','qwen'),('.zcode','AGENTS.md','glm')]:
        p=home/folder/name
        known=next((r for r in manifest['targets'] if pathlib.Path(r['path'])==p),None)
        if p.exists() and not known and p.read_bytes()!=raw:raise ValueError('Independent native rule: '+str(p))
        put(p,raw)
        if not known:manifest['targets'].append({'kind':kind,'profile':str(p.parent),'path':str(p),'last_sha256':sha(raw)})
    for p in (home/'.claude-session-hub/acp').glob('*/home'):
        # Seed only engines actually present in this isolated home.
        for folder,name,kind in [('.dsh','AGENTS.md','deepseek-acp'),('.qwen','QWEN.md','qwen'),('.zcode','AGENTS.md','glm')]:
            if not (p/folder).is_dir():continue
            target=p/folder/name;known=next((r for r in manifest['targets'] if pathlib.Path(r['path'])==target),None)
            if target.exists() and not known and target.read_bytes()!=raw:raise ValueError('Independent ACP rule: '+str(target))
            put(target,raw)
            if not known:manifest['targets'].append({'kind':kind,'profile':str(target.parent),'path':str(target),'last_sha256':sha(raw)})
    manifest['source_sha256']=sha(raw);put(manifest_path,(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    # Per-profile storage remains intact; Claude uses the existing shared index.
    memory=home/'.claude/projects/C--Users-lintian/memory'
    main_settings=home/'.claude/settings.json'
    common_claude=json.loads(main_settings.read_text(encoding='utf-8-sig')) if main_settings.exists() else {}
    policy['claudeDefaults']={'autoMemoryDirectory':str(memory)}
    if 'hooks' in common_claude:policy['claudeDefaults']['hooks']=common_claude['hooks']
    for row in manifest['targets']:
        if row['kind']!='claude':continue
        p=pathlib.Path(row['profile'])/'settings.json'
        c=json.loads(p.read_text(encoding='utf-8-sig')) if p.exists() else {}
        c['autoMemoryDirectory']=str(memory)
        if 'hooks' in common_claude:c['hooks']=copy.deepcopy(common_claude['hooks'])
        put(p,(json.dumps(c,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    put(home/'.agents/context-policy.json',(json.dumps(policy,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    return changes

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--home',type=pathlib.Path,required=True);ap.add_argument('--workspace',type=pathlib.Path,required=True);ap.add_argument('--codex-home',type=pathlib.Path,action='append',required=True);ap.add_argument('--apply',action='store_true');ap.add_argument('--check',action='store_true');ap.add_argument('--backup-root',type=pathlib.Path,required=True);args=ap.parse_args()
    changes=plan(args.home,args.codex_home,args.workspace)
    result={'mode':'apply' if args.apply else 'check','changes':len(changes),'files':[{'path':p,'before':sha(a) if a is not None else None,'after':sha(b)} for p,(a,b) in changes.items()]}
    if args.apply and changes:
        backup=args.backup_root/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f');backup.mkdir(parents=True,exist_ok=False)
        for i,(p,(a,b)) in enumerate(changes.items()):
            if a is not None:(backup/f'{i:03d}.before').write_bytes(a)
            result['files'][i]['backup']=str(backup/f'{i:03d}.before') if a is not None else None
        (backup/'manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        for p,(a,b) in changes.items():
            p=pathlib.Path(p)
            if (p.read_bytes() if p.exists() else None)!=a:raise ValueError('Concurrent modification: '+str(p))
            p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.context-sync-'+os.urandom(8).hex()+'.tmp');tmp.write_bytes(b);os.replace(tmp,p)
        result['backup']=str(backup)
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
