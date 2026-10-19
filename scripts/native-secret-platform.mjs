import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const sourceRoot = process.cwd();
const reportPath = path.join(sourceRoot, 'native-secret-platform-result.json');
const coreUrl = (file) => pathToFileURL(path.join(sourceRoot, 'packages/core/dist/src', file)).href;
const result = {
  platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
  sourceHead: process.env.NATIVE_SOURCE_HEAD, validationHead: process.env.GITHUB_SHA ?? null,
  builtTreeHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceBlobs: Object.fromEntries(['packages/core/src/extension/extensionManager.ts','packages/core/src/extension/extensionSettings.ts','packages/core/src/config/config.ts','packages/core/src/tools/mcp-client.ts'].map((file) => [file, execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim()])),
  backend: null, checks: [], productionRequests: 0, modelRequests: 0, toolsCall: 0,
  limitations: ['Only this hosted runner and its current session; no customer OS permission or lock-state coverage.'],
};
const record = (name, pass) => {
  result.checks.push({ name, pass: !!pass });
  assert.ok(pass, name);
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-native-platform-'));
const originalCwd = process.cwd();
const originalHome = process.env.QWEN_HOME;
const key = 'QWEN_NATIVE_PLATFORM_SYNTHETIC_TOKEN';
const userValue = `FAKE_NATIVE_USER_${randomUUID()}`;
const workspaceValue = `FAKE_NATIVE_WORKSPACE_${randomUUID()}`;
const name = `native-platform-${randomUUID()}`;
let server;
let keychain;
let userStorage;
let workspaceStorage;
let originalStderr;
const observed = [];
const warnings = [];
try {
  assert.notEqual(process.env.QWEN_CODE_FORCE_FILE_STORAGE, 'true', 'Do not force the encrypted backend');
  assert.equal(process.env[key], undefined, 'Synthetic setting cannot come from process env');
  process.env.QWEN_HOME = path.join(root, 'user');
  const a = path.join(root, 'workspace-a');
  const b = path.join(root, 'workspace-b');
  const c = path.join(root, 'workspace-c');
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  await fs.mkdir(c, { recursive: true });
  await fs.writeFile(path.join(b, '.env'), 'DAEMON_ONLY=original\n');
  await fs.writeFile(path.join(c, '.env'), 'OTHER_ONLY=original\n');
  await fs.writeFile(path.join(a, '.env'), 'TARGET_ONLY=original\nUNDECLARED_PROJECT_ONLY=project-value\n');
  const { ExtensionManager, getExtensionId } = await import(coreUrl('extension/extensionManager.js'));
  const { maybePromptForSettings, updateSetting, ExtensionSettingScope, getScopedEnvContents } = await import(coreUrl('extension/extensionSettings.js'));
  const { ExtensionStorage } = await import(coreUrl('extension/storage.js'));
  const { HybridTokenStorage } = await import(coreUrl('mcp/token-storage/hybrid-token-storage.js'));
  const { KeychainTokenStorage } = await import(coreUrl('mcp/token-storage/keychain-token-storage.js'));
  const { createMcpClient, createTransport } = await import(coreUrl('tools/mcp-client.js'));
  server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(request.method === 'DELETE' ? 200 : 405); response.end(); return; }
    let text = '';
    for await (const part of request) text += part;
    const message = JSON.parse(text);
    observed.push({ method: message.method, auth: request.headers.authorization });
    if (message.method === 'initialize') {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: 'native-localhost-only', version: '1.0.0' } } });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      response.end(payload);
    } else { response.writeHead(202); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    name, version: '0.1.0', description: `Metadata $${key}`,
    settings: [{ name: 'Synthetic Token', description: 'Fake-only hosted-runner fixture', envVar: key, sensitive: true }, { name: 'Label', description: 'Fixture', envVar: 'DECLARED_LABEL' }],
    mcpServers: { fixture: { httpUrl: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: `Bearer $${key}` }, env: { TOKEN_COPY: `$${key}`, LABEL: '$DECLARED_LABEL', PROJECT: '$UNDECLARED_PROJECT_ONLY' }, args: [`--token=$${key}`] } },
  };
  const id = getExtensionId(config);
  const extensionDir = new ExtensionStorage(name).getExtensionDir();
  await fs.mkdir(extensionDir, { recursive: true });
  const manifest = JSON.stringify(config);
  await fs.writeFile(path.join(extensionDir, 'qwen-extension.json'), manifest);
  const service = `Qwen Code Extensions ${name} ${id}`;
  keychain = new KeychainTokenStorage(service);
  result.keychainAvailable = await keychain.isAvailable();
  // This is the real backend availability probe. No mocks, force-file flag,
  // keychain creation/unlock, credential-manager reconfiguration or permission changes.
  userStorage = new HybridTokenStorage(service);
  result.backend = await userStorage.getStorageType();
  record('backend_matches_real_availability', result.backend === (result.keychainAvailable ? 'keychain' : 'encrypted_file'));
  record('real_secret_storage_available', await userStorage.isAvailable());
  await maybePromptForSettings(config, id, async (setting) => setting.sensitive ? userValue : 'user-label');
  const selector = JSON.parse(await fs.readFile(path.join(extensionDir, '.qwen-extension-settings.json'), 'utf8'));
  result.selectorBackend = selector.backend;
  record('selector_records_selected_backend', selector.backend === result.backend);
  const load = async (target, trusted = true) => {
    const manager = new ExtensionManager({ workspaceDir: target, isWorkspaceTrusted: trusted, usageStatisticsEnabled: false });
    await manager.refreshCache();
    const extension = manager.getLoadedExtensions().find((item) => item.name === name);
    record(`management_entry_${result.checks.length}`, !!extension);
    return { manager, extension };
  };
  process.chdir(b);
  let { manager, extension } = await load(a);
  record('user_saved_header', extension.mcpServers.fixture.headers.Authorization === `Bearer ${userValue}`);
  record('explicit_env_resolved', extension.mcpServers.fixture.env.TOKEN_COPY === userValue);
  record('args_saved_secret_not_expanded', extension.mcpServers.fixture.args[0] === `--token=$${key}`);
  record('stable_id', extension.id === id);
  record('metadata_saved_secret_not_expanded', extension.config.description === `Metadata $${key}`);
  const connect = async (mcp, expected) => {
    const start = observed.length;
    const client = createMcpClient('native-platform-test', mcp);
    const transport = await createTransport('native-platform-fixture', mcp, false);
    try { await client.connect(transport, { timeout: 10_000 }); } finally { await client.close(); }
    const requests = observed.slice(start).filter((item) => item.method === 'initialize');
    record(`localhost_header_${result.checks.length}`, requests.length === 1 && requests[0].auth === `Bearer ${expected}`);
  };
  await connect(extension.mcpServers.fixture, userValue);
  process.chdir(b);
  await updateSetting(config, id, key, async () => workspaceValue, ExtensionSettingScope.WORKSPACE, a);
  await updateSetting(config, id, 'DECLARED_LABEL', async () => 'target-label', ExtensionSettingScope.WORKSPACE, a);
  workspaceStorage = new HybridTokenStorage(`${service} ${await fs.realpath(a)}`);
  const targetValues = await getScopedEnvContents(config, id, ExtensionSettingScope.WORKSPACE, a);
  record('target_sensitive_write_readback', targetValues[key] === workspaceValue);
  record('target_ordinary_write_readback', targetValues.DECLARED_LABEL === 'target-label');
  record('undeclared_dotenv_excluded', !Object.hasOwn(targetValues, 'UNDECLARED_PROJECT_ONLY'));
  record('target_unrelated_dotenv_preserved', (await fs.readFile(path.join(a, '.env'), 'utf8')).includes('UNDECLARED_PROJECT_ONLY=project-value'));
  record('daemon_dotenv_unchanged', (await fs.readFile(path.join(b, '.env'), 'utf8')) === 'DAEMON_ONLY=original\n');
  record('other_dotenv_unchanged', (await fs.readFile(path.join(c, '.env'), 'utf8')) === 'OTHER_ONLY=original\n');
  for (const [target, label] of [[b, 'daemon'], [c, 'other']]) {
    const values = await getScopedEnvContents(config, id, ExtensionSettingScope.WORKSPACE, target);
    record(`${label}_has_no_workspace_setting`, !Object.hasOwn(values, key) && !Object.hasOwn(values, 'DECLARED_LABEL'));
    const isolated = await load(target);
    record(`${label}_uses_user_secret`, isolated.extension.mcpServers.fixture.headers.Authorization === `Bearer ${userValue}`);
    record(`${label}_uses_user_label`, isolated.extension.mcpServers.fixture.env.LABEL === 'user-label');
  }
  result.workspaceBackend = await workspaceStorage.getStorageType();
  result.workspaceDiagnostics = {
    requested: a,
    cwdWhileWriting: process.cwd(),
    realpath: await fs.realpath(a),
    requestedEqualsCwd: a === process.cwd(),
    requestedEqualsRealpath: a === await fs.realpath(a),
    fromRequestedMatches: (await getScopedEnvContents(config, id, ExtensionSettingScope.WORKSPACE, a))[key] === workspaceValue,
    fromCwdMatches: (await getScopedEnvContents(config, id, ExtensionSettingScope.WORKSPACE, process.cwd()))[key] === workspaceValue,
  };
  process.chdir(b);
  ({ manager, extension } = await load(a));
  record('target_ordinary_env_effective', extension.mcpServers.fixture.env.LABEL === 'target-label');
  record('undeclared_dotenv_not_substituted', extension.mcpServers.fixture.env.PROJECT === '$UNDECLARED_PROJECT_ONLY');
  record('target_workspace_overrides_cwd', extension.mcpServers.fixture.headers.Authorization === `Bearer ${workspaceValue}`);
  const direct = await manager.loadExtension({ extensionDir });
  record('omitted_reload_context_uses_manager_target', direct.mcpServers.fixture.headers.Authorization === `Bearer ${workspaceValue}`);
  await connect(extension.mcpServers.fixture, workspaceValue);
  const untrusted = await load(a, false);
  record('untrusted_workspace_only_user_secret', untrusted.extension.mcpServers.fixture.headers.Authorization === `Bearer ${userValue}`);
  await connect(untrusted.extension.mcpServers.fixture, userValue);
  record('global_env_not_modified', process.env[key] === undefined);
  record('manifest_unchanged', (await fs.readFile(path.join(extensionDir, 'qwen-extension.json'), 'utf8')) === manifest);
  const files = await fs.readdir(process.env.QWEN_HOME, { recursive: true });
  let plaintext = false;
  for (const file of files) {
    const absolute = path.join(process.env.QWEN_HOME, file);
    if ((await fs.stat(absolute)).isFile()) {
      const contents = await fs.readFile(absolute);
      if (contents.includes(Buffer.from(userValue)) || contents.includes(Buffer.from(workspaceValue))) plaintext = true;
    }
  }
  record('no_plaintext_in_isolated_profile', !plaintext);
  if (result.backend === 'keychain') {
    record('keychain_value_readback', await keychain.getSecret(key) === userValue);
    result.osKeychainVerdict = 'PASS: real selected backend, saved setting -> manager -> localhost Header';
  } else {
    result.osKeychainVerdict = 'UNAVAILABLE: real probe failed; only normal encrypted_file selection verified';
    result.limitations.push('System keychain/secret-service was unavailable in this runner; encrypted-file result does not validate OS keychain.');
  }
  await userStorage.deleteSecret(selector.bundleKey);
  originalStderr = process.stderr.write;
  process.stderr.write = function(chunk, ...rest) { warnings.push(String(chunk)); return originalStderr.call(this, chunk, ...rest); };
  const broken = await load(a);
  record('safe_missing_bundle_diagnostic', warnings.some((item) => item.includes('settings:bundle-missing')));
  record('missing_bundle_disables_mcp', !broken.extension.mcpServers && !broken.extension.config.mcpServers);
  record('missing_bundle_fixed_recovery_warning', warnings.some((item) => item.includes('Check credential storage availability') && item.includes('before uninstalling and reinstalling')));
  record('warning_does_not_contain_synthetic_secret', warnings.every((item) => !item.includes(userValue) && !item.includes(workspaceValue)));
  record('no_tools_call', observed.every((item) => item.method !== 'tools/call'));
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  // Only fixture assertion names / error class; do not dump settings or headers.
  result.error = { name: error.name, message: String(error.message).replaceAll(userValue, '[REDACTED]').replaceAll(workspaceValue, '[REDACTED]') };
  process.exitCode = 1;
} finally {
  if (originalStderr) process.stderr.write = originalStderr;
  // Namespaced fake entries only. Leave the runner's keychain configuration alone.
  for (const storage of [userStorage, workspaceStorage]) {
    if (storage) for (const secret of await storage.listSecrets().catch(() => [])) await storage.deleteSecret(secret).catch(() => {});
  }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.QWEN_HOME; else process.env.QWEN_HOME = originalHome;
  await fs.rm(root, { recursive: true, force: true });
  result.checksPassed = result.checks.filter((item) => item.pass).length;
  result.secretVariableForced = false;
  const content = JSON.stringify(result, null, 2) + '\n';
  assert.ok(!content.includes(userValue) && !content.includes(workspaceValue));
  await fs.writeFile(reportPath, content);
  console.log(content);
}
