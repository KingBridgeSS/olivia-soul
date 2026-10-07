// Real Electron renderer/preload with local dsh and memory fixtures; no cloud writes.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dshServer } from '../tests/helpers/dsh-server';

async function main() {
  const root = process.cwd(); fs.mkdirSync('.cache', { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.cache/memory-ui-'));
  const server = await dshServer();
  const config = path.join(dir, 'config.env');
  fs.writeFileSync(config, `app_id=test-app\nkey=test-key\nworkspace_id=test-workspace\ndsh_url=${server.url}\ndsh_cwd=${root.replaceAll('\\', '/')}\ngpu_enabled=false\nALIBABA_CLOUD_ACCESS_KEY_ID=fake-ak\nALIBABA_CLOUD_ACCESS_KEY_SECRET=fake-secret\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  // Override any developer credentials for the entire fixture process.
  env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'fake-ak'; env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'fake-secret';
  const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'dist/main/index.cjs'), `--user-data-dir=${dir}`, '--import-env', config], env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.soul);
    // Real handler validates malformed writes before making a request.
    await assert.rejects(page.evaluate(() => window.soul.memory({ command: 'create', project: 'observation_project', content: ' ' })), /不能为空/);
    await app.evaluate(({ ipcMain }) => {
      const observation = Array.from({ length: 21 }, (_, i) => ({ memoryNodeId: `o-${i}`, content: i === 0 ? '用户喜欢在晚上阅读，也喜欢安静的环境。' : `测试记忆 ${i + 1}` }));
      const profile = [{ memoryNodeId: 'p-1', content: '用户正在学习计算机科学。' }];
      const fixture = { observation, profile, calls: [] as any[], fail: false, failAfterWrite: false };
      (globalThis as any).memoryFixture = fixture;
      ipcMain.removeHandler('soul:memory');
      ipcMain.handle('soul:memory', async (_, r) => {
        fixture.calls.push(r);
        if (fixture.fail) throw new Error('测试网络错误');
        const nodes = r.project === 'profile_project' ? profile : observation;
        const all = [...observation, ...profile];
        if (r.command === 'list') return { user: 'olivia-soul', data: { total: String(nodes.length), memoryNodes: nodes.slice((r.page - 1) * 20, r.page * 20) } };
        if (r.command === 'profile') return { user: 'olivia-soul', data: { attributes: [{ name: '教育背景', value: '原画像值' }] } };
        if (r.command === 'create') nodes.push({ memoryNodeId: `new-${fixture.calls.length}`, content: r.content });
        if (r.command === 'update') all.find(n => n.memoryNodeId === r.id)!.content = r.content;
        if (r.command === 'delete') for (const list of [observation, profile]) { const i = list.findIndex(n => n.memoryNodeId === r.id); if (i >= 0) list.splice(i, 1); }
        if (fixture.failAfterWrite) fixture.fail = true;
        return { user: 'olivia-soul' };
      });
    });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    const portrait = await page.locator('.portrait').boundingBox();
    await page.locator('#memory-toggle').click();
    await page.waitForFunction(() => document.getElementById('memory-count')?.textContent === '1 / 2 页 · 21 条');
    assert.equal(await page.locator('#call').isVisible(), true);
    assert.deepEqual(await page.locator('.portrait').boundingBox(), portrait);
    await page.locator('#memory-next').click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-item').length === 1);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('memory-count')?.textContent === '1 / 1 页 · 20 条');
    await page.locator('#memory-project').selectOption('profile_project');
    await page.waitForFunction(() => document.querySelectorAll('.memory-item').length === 1);
    await page.locator('#memory-add').click();
    const literal = '<img src=x onerror=alert(1)>\n用户喜欢阅读科幻小说。';
    await page.locator('#memory-content').fill(literal);
    await page.locator('#memory-back').click();
    await page.locator('#memory-toggle').click();
    assert.equal(await page.locator('#memory-content').inputValue(), literal);
    await page.locator('#memory-save').click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-item').length === 2);
    assert.equal(await page.locator('#memory-list img').count(), 0);
    assert.ok((await page.locator('#memory-list').textContent())?.includes(literal));
    await page.getByRole('button', { name: '编辑', exact: true }).last().click();
    await page.locator('#memory-content').fill('已修正的记忆');
    await page.locator('#memory-save').click();
    await page.waitForFunction(() => document.getElementById('memory-list')?.textContent?.includes('已修正的记忆'));
    await page.locator('#memory-profile summary').click();
    await page.waitForFunction(() => document.getElementById('memory-profile-content')?.textContent?.includes('原画像值'));
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/memory-page.png' });
    await app.evaluate(() => { (globalThis as any).memoryFixture.fail = true; });
    await page.locator('#memory-refresh').click();
    await page.waitForFunction(() => document.getElementById('memory-message')?.textContent?.includes('测试网络错误'));
    assert.equal(await page.locator('.memory-item').count(), 0);
    assert.equal(await page.locator('#memory-add').isDisabled(), true);
    await app.evaluate(() => { (globalThis as any).memoryFixture.fail = false; });
    await page.locator('#memory-refresh').click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-item').length === 2);
    await page.locator('#memory-add').click();
    await page.locator('#memory-content').fill('保存成功后刷新失败');
    await app.evaluate(() => { (globalThis as any).memoryFixture.failAfterWrite = true; });
    await page.locator('#memory-save').click();
    await page.waitForFunction(() => document.getElementById('memory-message')?.textContent?.includes('已新增，但刷新失败'));
    assert.equal(await page.locator('#memory-editor').isVisible(), false);
    await page.locator('#memory-back').click();
    assert.equal(await page.locator('#task-toggle').isEnabled(), true);
    const state = await page.evaluate(() => window.soul.state());
    assert.equal(state.connected, false);
    assert.ok(!JSON.stringify(state).includes('fake-secret'));
    assert.deepEqual(errors, []);
    console.log('Memory UI passed: navigation, paging, create/edit/delete, literal text, draft retention, profile, failure/retry and refresh-after-write failure.');
  } finally { await app.close(); await server.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
