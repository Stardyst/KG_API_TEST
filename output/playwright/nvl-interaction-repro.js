const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Users/Stardust/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 820 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:8010/?repro=nvl-interaction", { waitUntil: "networkidle" });
  await page.waitForSelector("#graphCanvas canvas", { timeout: 30000 });
  await page.waitForTimeout(3500);

  const box = await page.locator("#graphCanvas").boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const beforeImage = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("#graphCanvas canvas")).find((item) => item.getContext("2d"));
    return canvas.toDataURL();
  });

  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(300);
  const afterWheelImage = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("#graphCanvas canvas")).find((item) => item.getContext("2d"));
    return canvas.toDataURL();
  });

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDragImage = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("#graphCanvas canvas")).find((item) => item.getContext("2d"));
    return canvas.toDataURL();
  });

  const hit = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("#graphCanvas canvas")).find((item) => item.getContext("2d"));
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d");
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    let point = null;
    for (let y = 0; y < canvas.height; y += 6) {
      for (let x = 0; x < canvas.width; x += 6) {
        const index = (y * canvas.width + x) * 4;
        const r = image[index];
        const g = image[index + 1];
        const b = image[index + 2];
        const a = image[index + 3];
        const isNodePixel = a > 180 && (Math.abs(r - g) > 25 || Math.abs(g - b) > 25 || Math.abs(r - b) > 25);
        const isBackground = r > 235 && g > 240 && b > 245;
        if (isNodePixel && !isBackground) {
          point = { x: rect.left + x * scaleX, y: rect.top + y * scaleY };
          break;
        }
      }
      if (point) break;
    }
    if (!point) return null;
    const event = new MouseEvent("click", {
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
    });
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(event);
    return point;
  });
  await page.waitForTimeout(300);
  const detailVisible = await page.evaluate(() => {
    const detail = document.querySelector("#graphDetail");
    return Boolean(detail && !detail.hidden && detail.textContent.trim());
  });
  const beforeNodeDragImage = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("#graphCanvas canvas")).find((item) => item.getContext("2d"));
    return canvas.toDataURL();
  });
  if (hit) {
    await page.mouse.move(hit.x, hit.y);
    await page.mouse.down();
    await page.mouse.move(hit.x + 90, hit.y + 45, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  const afterNodeDragImage = await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll("#graphCanvas canvas")).find((item) => item.getContext("2d"));
    return canvas.toDataURL();
  });
  const collisionResult = await runCollisionCheck(page);

  console.log(
    JSON.stringify(
      {
        wheelChangedCanvas: beforeImage !== afterWheelImage,
        dragChangedCanvas: afterWheelImage !== afterDragImage,
        nodeDragChangedCanvas: beforeNodeDragImage !== afterNodeDragImage,
        collisionMovedNearbyNode: collisionResult.moved,
        collisionResult,
        hit,
        detailVisible,
        errors,
      },
      null,
      2
    )
  );
  await browser.close();
}

async function runCollisionCheck(page) {
  const pair = await page.evaluate(() => {
    const debug = window.KgNvlPreview?.debug?.();
    if (!debug?.positions?.length) return null;
    const nodes = debug.positions.filter((node) => node.id && Number.isFinite(node.x) && Number.isFinite(node.y));
    let best = null;
    for (const dragged of nodes) {
      for (const target of nodes) {
        if (dragged.id === target.id) continue;
        const distance = Math.hypot(target.x - dragged.x, target.y - dragged.y);
        if (distance < 30 || distance > 260) continue;
        if (!best || distance < best.distance) best = { dragged, target, distance };
      }
    }
    if (!best) return null;
    const { rect, pan, zoom } = debug;
    const toScreen = (node) => ({
      x: rect.left + rect.width / 2 + (node.x - pan.x) * zoom,
      y: rect.top + rect.height / 2 + (node.y - pan.y) * zoom,
    });
    return {
      dragged: best.dragged,
      target: best.target,
      draggedScreen: toScreen(best.dragged),
      targetScreen: toScreen(best.target),
      distance: best.distance,
    };
  });

  if (!pair) return { moved: false, reason: "missing-debug-or-pair" };
  await page.mouse.move(pair.draggedScreen.x, pair.draggedScreen.y);
  await page.mouse.down();
  await page.mouse.move(pair.targetScreen.x, pair.targetScreen.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await page.evaluate((targetId) => {
    const debug = window.KgNvlPreview?.debug?.();
    return debug?.positions?.find((node) => node.id === targetId) || null;
  }, pair.target.id);
  if (!after) return { moved: false, reason: "target-not-found", pair };
  const displacement = Math.hypot(after.x - pair.target.x, after.y - pair.target.y);
  return {
    moved: displacement >= 4,
    displacement,
    pair: {
      draggedId: pair.dragged.id,
      targetId: pair.target.id,
      initialDistance: pair.distance,
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
