import { api, esc, topbar, enableTips } from '/ui/common.js';

const $ = (id) => document.getElementById(id);
$('top').innerHTML = topbar('settings');
enableTips();
const PATHS = [
  ['root', 'Research workspace', 'corePaths'],
  ['papersDir', 'Library PDF folder', 'corePaths'],
  ['inboxDir', 'Paper inbox', 'corePaths'],
  ['claudeProjects', 'Claude Code projects', 'extraPaths'],
  ['codexSessions', 'Codex sessions', 'extraPaths'],
  ['scienceDb', 'Claude Science database', 'extraPaths'],
  ['claudeLimits', 'Claude usage cache', 'extraPaths'],
  ['calendar', 'Calendar cache', 'extraPaths'],
];
let current;

function render(data) {
  current = data;
  $('appChoices').innerHTML = data.apps.map((app) => `<label class="app-choice" data-tip="${esc(app.detail)}"><input type="checkbox" data-app="${esc(app.id)}" ${app.enabled ? 'checked' : ''}><span><span class="name">${esc(app.name)}</span><span class="detail">${app.detected ? 'Detected on this Mac' : app.id === 'chatgpt' || app.id === 'claude' ? 'Conversation links' : 'Not detected'}</span></span></label>`).join('');
  for (const area of ['corePaths', 'extraPaths']) $(area).innerHTML = PATHS.filter(([, , group]) => group === area).map(([key, label]) => `<label class="field">${label}<input type="text" data-path="${key}" value="${esc(data.config.paths?.[key] || '')}" placeholder="Automatic" autocomplete="off" spellcheck="false"></label><p class="field-hint">Using <code>${esc(data.effective[key] || 'No source detected')}</code></p>`).join('');
  const vaults = data.detected.vaults.filter((v) => v.exists);
  const selected = data.effective.obsidianVault;
  const custom = selected && !vaults.some((v) => v.path === selected);
  const suggestion = !selected ? vaults.find((v) => v.open) || vaults[0] : null;
  $('vaultSelect').innerHTML = `<option value="">No vault selected</option>${vaults.map((v) => `<option value="${esc(v.path)}">${esc(v.name)}${v.open ? ' (open)' : ''}</option>`).join('')}<option value="__custom">Choose by path…</option>`;
  $('vaultSelect').value = custom ? '__custom' : selected || suggestion?.path || '';
  $('customVault').value = custom ? selected : '';
  $('vaultHint').textContent = suggestion ? `Suggested: ${suggestion.path}. Save settings to use this vault.` : selected || 'Choose a vault already opened in Obsidian, or enter its path.';
  $('customVaultField').classList.toggle('hidden', $('vaultSelect').value !== '__custom');
  $('paperFolder').value = data.effective.obsidianFolder;
  $('timezone').value = data.effective.timezone;
  $('sources').innerHTML = data.sources.map((source) => `<div class="source-row"><div class="source-top"><span>${esc(source.name)}</span><span class="source-state ${source.available && source.enabled ? 'available' : ''}">${esc(source.status)}</span></div><div class="source-path">${esc(source.path || (source.id === 'obsidian' ? 'Choose a vault to connect' : 'No path detected'))}</div></div>`).join('');
  $('configPath').textContent = data.configFile;
}

$('vaultSelect').addEventListener('change', () => {
  $('customVaultField').classList.toggle('hidden', $('vaultSelect').value !== '__custom');
  $('vaultHint').textContent = $('vaultSelect').value === '__custom' ? 'Enter the full path to a folder containing .obsidian.' : $('vaultSelect').value || 'No vault will be read.';
});
$('settingsForm').addEventListener('input', () => { $('saveStatus').textContent = 'Unsaved changes'; $('saveError').classList.add('hidden'); });
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { paths: {}, apps: {}, obsidian: {
    vaultPath: $('vaultSelect').value === '__custom' ? $('customVault').value : $('vaultSelect').value,
    paperFolder: $('paperFolder').value,
  }, timezone: $('timezone').value };
  document.querySelectorAll('[data-path]').forEach((input) => { body.paths[input.dataset.path] = input.value; });
  document.querySelectorAll('[data-app]').forEach((input) => { body.apps[input.dataset.app] = input.checked; });
  $('save').disabled = true;
  $('saveStatus').textContent = 'Saving…';
  $('saveError').classList.add('hidden');
  try {
    const saved = await api('/api/settings', body);
    render(saved);
    $('saveStatus').textContent = 'Saved';
  } catch (err) {
    $('saveStatus').textContent = '';
    $('saveError').textContent = err.message;
    $('saveError').classList.remove('hidden');
  } finally { $('save').disabled = false; }
});

api('/api/settings').then((data) => {
  render(data);
  $('loading').classList.add('hidden');
  $('settingsContent').classList.remove('hidden');
}).catch((err) => { $('loading').textContent = err.message; });
void current;

$('syncKnowledge').addEventListener('click', async () => {
  $('syncKnowledge').disabled = true;
  $('knowledgeStatus').textContent = 'Linking existing materials…';
  try {
    const result = await api('/api/knowledge/sync', { dryRun: false });
    const counts = result.summary || {};
    const summary = Object.entries(counts).map(([key, n]) => `${n} ${key}`).join(' · ');
    const conflicts = (result.changes || []).filter((row) => row.action === 'conflict').map((row) => row.path || row.relative || row.id).filter(Boolean);
    $('knowledgeStatus').textContent = `${summary || 'No changes.'}${conflicts.length ? ` Conflicts preserved: ${conflicts.join(', ')}` : ' Open your vault in Obsidian to read the linked materials.'}`;
  } catch (error) { $('knowledgeStatus').textContent = error.message; }
  finally { $('syncKnowledge').disabled = false; }
});
