import json,pathlib,subprocess,tempfile,os,pexpect,hashlib
root=pathlib.Path.cwd();cli=root/'qwen-release/bin/qwen';node=root/'qwen-release/node/bin/node';r={'cli_version':'0.25.2','release_catalog_commit':'fa17a2bcb3213e6af5861a3a70438f05792ffef8','scope':'officialLinuxCLIremoteDiscoverarchiveinstallation','production_requests':0,'production_mcp_connections':0,'model_requests':0,'tools_call':0,'tests':[]}
with tempfile.TemporaryDirectory(prefix='qwen-hosted-source-') as td:
 p=pathlib.Path(td)
 for n in ['home','user','project']:(p/n).mkdir()
 preload=p/'home.cjs';preload.write_text("require('node:os').homedir=()=>"+json.dumps(str(p/'home'))+';\n');(p/'user/settings.json').write_text('{"$version":4,"general":{"enableAutoUpdate":false},"privacy":{"usageStatisticsEnabled":false}}')
 env={'PATH':os.environ['PATH'],'QWEN_HOME':str(p/'user'),'QWEN_RUNTIME_DIR':str(p/'runtime'),'QWEN_CODE_SYSTEM_SETTINGS_PATH':str(p/'none.json'),'QWEN_CODE_SYSTEM_DEFAULTS_PATH':str(p/'none2.json'),'NODE_OPTIONS':'--require='+str(preload),'QWEN_CODE_FORCE_FILE_STORAGE':'true','TERM':'xterm-256color','NO_COLOR':'1'}
 source='https://raw.githubusercontent.com/AceDataCloud/AceDataCloudQwenCode/main/.claude-plugin/marketplace.json';q=subprocess.run([str(cli),'extensions','sources','add',source],env=env,cwd=p/'project',text=True,capture_output=True,timeout=150);r['source_add']={'exit':q.returncode,'url':source,'tail':(q.stdout+q.stderr)[-900:]};assert q.returncode==0
 chunk=next(x for x in (root/'qwen-release/lib/chunks').glob('*.js') if 'ExtensionManager=class' in x.read_text() or 'class ExtensionManager' in x.read_text() or 'ExtensionManager = class' in x.read_text())
 # Release chunks re-export ExtensionManager only from its declaration chunk.
 inspect=p/'inspect.mjs';inspect.write_text('import{ExtensionManager}from'+json.dumps(chunk.as_uri())+';const m=new ExtensionManager({workspaceDir:process.cwd(),isWorkspaceTrusted:true,usageStatisticsEnabled:false});await m.refreshCache();console.log(JSON.stringify((await m.discoverPlugins({refresh:true})).map(({name,description,author,installSource})=>({name,description,author,installSource}))));')
 q=subprocess.run([str(node),str(inspect)],env=env,cwd=p/'project',text=True,capture_output=True,timeout=150);assert q.returncode==0,q.stderr[-1000:];entries=json.loads(q.stdout.strip().splitlines()[-1]);r['discovered']=entries;assert len(entries)==5
 for item in entries:
  c=pexpect.spawn(str(cli),['extensions','install',item['installSource'],'--consent'],env=env,cwd=p/'project',encoding='utf-8',timeout=180);i=c.expect(['Ace Data Cloud API Token',pexpect.EOF,pexpect.TIMEOUT]);output=c.before;fake='SYNTHETIC_HOSTED_SETUP_NOT_A_TOKEN'
  if i==0:c.sendline(fake);c.expect(pexpect.EOF);output+=c.before
  c.close();d=p/'user/extensions'/item['name'];manifest=json.loads((d/'qwen-extension.json').read_text()) if (d/'qwen-extension.json').exists() else {};meta=json.loads((d/'.qwen-extension-install.json').read_text()) if (d/'.qwen-extension-install.json').exists() else {};q=subprocess.run([str(cli),'extensions','settings','list',item['name']],env=env,cwd=p/'project',text=True,capture_output=True,timeout=90);plain=[str(f.relative_to(p/'user')) for f in (p/'user').rglob('*') if f.is_file() and fake.encode() in f.read_bytes()];ok=c.exitstatus==0 and i==0 and manifest.get('version')=='0.1.0-rc.1' and q.returncode==0 and fake not in output+q.stdout+q.stderr and not plain
  info={'name':item['name'],'source':item['installSource'],'exit':c.exitstatus,'prompt':i==0,'version':manifest.get('version'),'metadata':meta,'no_displayed_secret':fake not in output+q.stdout+q.stderr,'no_plaintext':not plain,'pass':ok}
  if not ok:info['diagnostic_tail']=(output+q.stdout+q.stderr)[-1600:].replace(fake,'[REDACTED]')
  r['tests'].append(info);(root/'published-discover-install-result.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(info),flush=True)
 r['status']='PASS' if len(r['tests'])==5 and all(x['pass'] for x in r['tests']) else 'FAIL'
(root/'published-discover-install-result.json').write_text(json.dumps(r,indent=2)+'\n');assert r['status']=='PASS'
