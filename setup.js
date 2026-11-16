import { checkKey, maskKey } from './lib/openai.js';

const $ = (id) => document.getElementById(id);

async function micState() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; }
  catch { return 'prompt'; }
}

async function refresh() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  $('step-key').classList.toggle('done', !!settings.key);
  if (settings.key) $('key').placeholder = maskKey(settings.key);
  const editing = $('key-row').dataset.editing === '1';
  $('key-row').hidden = !!settings.key && !editing;
  $('key-saved').hidden = !settings.key || editing;
  if (settings.key) $('key-saved').innerHTML = `Your key ${maskKey(settings.key)} is saved. <a id="change-key">Change</a>`;
  $('change-key')?.addEventListener('click', () => { $('key-row').dataset.editing = '1'; refresh(); $('key').focus(); });
  const mic = await micState();
  $('step-mic').classList.toggle('done', mic === 'granted');
  $('allow-mic').hidden = mic === 'granted';
  if (mic === 'granted') $('mic-status').textContent = 'Scribe can hear your microphone.';
  else if (mic === 'denied') $('mic-status').textContent = 'The browser is blocking the microphone for Scribe. Click the icon at the right of the address bar, allow the microphone, then reload this page.';
}

$('allow-mic').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    $('mic-status').textContent = e.name === 'NotFoundError'
      ? 'No microphone found. Plug one in and try again.'
      : `The microphone wasn't allowed (${e.name}).`;
  }
  refresh();
};

$('save').onclick = async () => {
  const key = $('key').value.trim();
  if (!key) return;
  $('key-status').textContent = 'Checking the key with OpenAI…';
  const outcome = await checkKey(key);
  if (outcome.kind === 'text' || outcome.kind === 'busy' || outcome.kind === 'noCredit') {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, key }, problem: null });
    $('key').value = '';
    delete $('key-row').dataset.editing;
    $('key-status').textContent = outcome.kind === 'noCredit'
      ? 'Saved, but this OpenAI account is out of credit.' : 'Saved. OpenAI accepted it.';
  } else {
    $('key-status').textContent = outcome.message || 'Couldn\'t reach OpenAI to check the key.';
  }
  refresh();
};

refresh();
