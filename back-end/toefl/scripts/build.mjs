import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const frontEndRoot = path.join(repositoryRoot, 'front-end/toefl');
export const docsRoot = path.join(repositoryRoot, 'docs/toefl');
export const distRoot = path.join(repositoryRoot, 'local-data/builds/toefl');
export const anonymousFrontendFiles = Object.freeze([
  'index.html', 'four.css', 'four-logic.js', 'four-learning.js', 'four-app.js', 'favicon.svg',
]);
const json = async name => JSON.parse(await readFile(path.join(moduleRoot, name), 'utf8'));

// This build accepts only committed anonymous fixtures. Real resources and
// production keys require a separate, explicitly reviewed publishing workflow.
export async function build() {
  const data = await json('fixtures/anonymous-bank.json');
  if (data.fixture !== true || data.records.some(r => r.source !== 'ANONYMOUS_FIXTURE')) {
    throw new Error('Local intake builds require anonymous fixtures.');
  }
  await rm(distRoot, { recursive: true, force: true });
  const preview = path.join(distRoot, 'preview');
  const cloud = path.join(distRoot, 'cloud-test');
  await mkdir(preview, { recursive: true });
  await mkdir(cloud, { recursive: true });
  for (const name of anonymousFrontendFiles) await cp(path.join(frontEndRoot, name), path.join(preview, name));
  await cp(path.join(moduleRoot, 'src'), cloud, { recursive: true });
  // Private cloud-test assembly stays outside the anonymous public directory.
  for (const name of ['bootstrap.js', 'cloud-client.js', 'accounts-client.js']) {
    await cp(path.join(frontEndRoot, 'clients', name), path.join(cloud, name));
  }
  for (const name of ['accounts.html', 'register.html']) {
    await cp(path.join(frontEndRoot, 'templates', name), path.join(cloud, name));
  }
  await cp(path.join(moduleRoot, 'tests/cloud'), cloud, { recursive: true });
  await writeFile(path.join(preview, 'four-data.js'), `window.FOUR_DATA=${JSON.stringify(data)};\n`);

  // Two seconds of a synthetic tone exercise media loading and timing only.
  // This is deliberately not a simulated spoken model answer.
  const rate = 8000, seconds = 2, samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  await mkdir(path.join(preview, 'audio'), { recursive: true });
  await writeFile(path.join(preview, 'audio/fixture-tone.wav'), wav);
  await mkdir(path.join(preview, 'images'), { recursive: true });
  await cp(path.join(moduleRoot, 'fixtures/anonymous-scene.svg'), path.join(preview, 'images/fixture-scene.svg'));
  const html = await readFile(path.join(preview, 'index.html'), 'utf8');
  await writeFile(path.join(preview, 'index.html'), html
    .replace('<title>TOEFL Practice · 模拟考试</title>', '<title>本地接入样例 · TOEFL Practice</title>')
    .replace('<body>', '<body><p style="margin:0;padding:8px;text-align:center;font:13px system-ui;background:#ececf5;color:#272739">本地匿名样例 · 音频为测试提示音 · 不连接正式账号或云端 AI</p>'));

  const app = await readFile(path.join(frontEndRoot, 'four-app.js'), 'utf8');
  const filter = "r.source==='JIJING'";
  if (!app.includes(filter)) throw new Error('Source bank filter changed; review anonymous preview adapter.');
  await writeFile(path.join(preview, 'four-app.js'), app.replace(filter,
    "(r.source==='JIJING'||D.fixture===true&&r.source==='ANONYMOUS_FIXTURE')"));
  const brand = app.match(/function brandMark\(\)\{return `(.+?)`\}/)?.[1];
  if (!brand) throw new Error('Brand template missing.');
  const css = await readFile(path.join(frontEndRoot, 'four.css'), 'utf8');
  const learning = await readFile(path.join(frontEndRoot, 'four-learning.js'), 'utf8');
  const client = await readFile(path.join(cloud, 'accounts-client.js'), 'utf8');
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(await readFile(path.join(preview, 'favicon.svg'), 'utf8'));
  const pages = [];
  for (const name of ['accounts', 'register']) {
    const page = (await readFile(path.join(cloud, `${name}.html`), 'utf8'))
      .replace('__FAVICON__', favicon).replace('__BRAND__', brand)
      .replace('__CSS__', css)
      .replace('__LEARNING__', learning.replaceAll('</script', '<\\/script'))
      .replace('__CLIENT__', client.replaceAll('</script', '<\\/script'));
    pages.push(`export const ${name}Page=${JSON.stringify(page)};`);
  }
  await writeFile(path.join(cloud, 'account-pages.mjs'), pages.join('\n') + '\n');
  await writeFile(path.join(cloud, 'vocab-groups.json'), JSON.stringify(data.vocabGroups) + '\n');
  await writeFile(path.join(distRoot, 'build-info.json'), JSON.stringify({
    mode: 'local-anonymous-intake', records: data.records.length,
    productionCredentials: false, productionData: false, deployable: false
  }, null, 2) + '\n');
  return { preview, cloud, records: data.records.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await build();
  console.log(`Local anonymous preview built: ${result.records} sample records. No deployment package created.`);
}
