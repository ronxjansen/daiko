import { chromium } from 'playwright'

const base = 'http://localhost:4680'
const artifact = '976f9f3c-034a-40ef-98a4-da152c67a8d9'
const project = '0ffb141f-9922-4c76-be2e-9312736b3874'
const pages = [
  ['dashboard', '/'],
  ['projects', '/projects'],
  ['project-detail', `/projects/${project}`],
  ['skills', '/skills'],
  ['artifact-detail', `/artifacts/${artifact}`],
]
const viewports = [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]

const browser = await chromium.launch()
for (const [vpName, viewport] of viewports) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  for (const [name, path] of pages) {
    await page.goto(base + path, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `.impeccable/shots/${name}-${vpName}.png` })
  }
  await ctx.close()
}
await browser.close()
console.log('done')
