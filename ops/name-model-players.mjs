// Functional identity creation: at most four initial calls and four name repairs.
// Existing model-chosen names are retained. No game or benchmark is run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient, parseAction } from '../codex-provider.js';
import { MODEL_PRESETS } from '../public/model-presets.js';
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'model-names.json');
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, profiles: {} };
const client = new CodexAppServerClient();
let calls = 0;
try {
  for (const preset of MODEL_PRESETS) {
    if (data.profiles[preset.id]?.name) continue;
    const used = Object.values(data.profiles).map((profile) => profile.name);
    let name;
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      const result = await client.runTurn({ model: preset.model, effort: preset.effort,
        developerInstructions: 'This task only creates your own tavern player name. No card decision is needed. Reply with the requested name JSON.',
        text: `你是骗子酒馆中的 ${preset.label} 玩家。请自己取一个有个性、适合酒馆的中文名字，2至6个汉字，不加标点，不使用模型名。不要使用已有名字：${used.join('、') || '无'}。只回复 {"name":"你取的名字"}。`,
        outputSchema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 6 } }, required: ['name'] },
      });
      try { name = parseAction(result.text).name; } catch { name = null; }
      if (typeof name === 'string' && /^[\p{Script=Han}]{2,6}$/u.test(name) && !used.includes(name)) break;
      name = null;
    }
    if (!name) throw new Error(`${preset.id} did not choose a valid name within the call budget`);
    data.profiles[preset.id] = { ...preset, name, chosenByModel: true, createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    console.log(JSON.stringify({ model: preset.model, effort: preset.effort, name, calls }));
  }
} finally { await client.close(); }
