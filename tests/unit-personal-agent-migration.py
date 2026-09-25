"""Migration must preserve legacy Hub table discovery and be idempotent."""
import importlib.util, json, pathlib, re, tempfile, tomllib, unittest

spec=importlib.util.spec_from_file_location('migration',pathlib.Path(__file__).resolve().parents[1]/'scripts/sync-personal-agent-context.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MigrationTests(unittest.TestCase):
    def test_legacy_hub_can_recognize_project_and_mcp_headers(self):
        data={'projects':{r'c:\aiwork\项目':{'trust_level':'trusted'}},'mcp_servers':{'example-server':{'command':'node'}},'notice':{'model_migrations':{'gpt-5.5':'gpt-6-astra'}}}
        text=m.toml(data).decode()
        self.assertEqual(tomllib.loads(text),data)
        self.assertEqual(re.findall(r"^\[projects\.'([^']+)'\]\s*$",text,re.M),[r'c:\aiwork\项目'])
        self.assertIn('[mcp_servers.example-server]',text)

    def fixture(self,base):
        home=base/'home';workspace=base/'work';workspace.mkdir();home.mkdir()
        for name in ['AGENTS.md','CLAUDE.md','GEMINI.md']:(workspace/name).write_text('<!-- old -->\nSame workspace rules\n',encoding='utf-8')
        root=home/'.agents';root.mkdir();(root/'USER_CONTEXT.md').write_text('# Person\n## 记忆与加载\n',encoding='utf-8')
        (root/'user-context-targets.json').write_text(json.dumps({'targets':[]}),encoding='utf-8')
        accounts=[home/'primary',home/'secondary']
        for i,p in enumerate(accounts):
            p.mkdir();(p/'config.toml').write_bytes(m.toml({'model':'model-'+str(i),'model_provider':'private-'+str(i),'projects':{str(workspace/str(i)):{'trust_level':'trusted'}}}))
            (p/'auth.json').write_text('credential-'+str(i))
        return home,accounts,workspace

    def test_migration_is_idempotent_and_keeps_credentials_and_provider(self):
        with tempfile.TemporaryDirectory() as temp:
            home,accounts,workspace=self.fixture(pathlib.Path(temp))
            changes=m.plan(home,accounts,workspace)
            for filename,(_,body) in changes.items():
                p=pathlib.Path(filename);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body)
            self.assertEqual(m.plan(home,accounts,workspace),{})
            for i,p in enumerate(accounts):
                config=tomllib.loads((p/'config.toml').read_text())
                self.assertEqual(config['model'],'model-0')
                self.assertEqual(config['model_provider'],'private-'+str(i))
                self.assertFalse(config['memories']['use_memories'])
                self.assertEqual(len(config['projects']),2)
                self.assertEqual((p/'auth.json').read_text(),'credential-'+str(i))

    def test_conflicting_trust_does_not_choose_broader_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            home,accounts,workspace=self.fixture(pathlib.Path(temp))
            for i,p in enumerate(accounts):(p/'config.toml').write_bytes(m.toml({'projects':{'same':{'trust_level':['trusted','untrusted'][i]}}}))
            with self.assertRaisesRegex(ValueError,'Conflicting project trust'):m.plan(home,accounts,workspace)

if __name__=='__main__':unittest.main()
