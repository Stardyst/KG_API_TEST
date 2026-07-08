const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Users/Stardust/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 820 } });
  const errors = [];
  let candidateRequestCount = 0;
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (decodeURI(request.url()).includes("/api/字段候选值")) candidateRequestCount += 1;
  });

  await page.goto("http://127.0.0.1:8010/?repro=filter-candidates", { waitUntil: "networkidle" });
  await page.waitForSelector(".filter-row .filter-field", { timeout: 30000 });

  const scenario = await page.evaluate(async () => {
    async function post(path, body = {}) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    }

    const eventTypes = (await post("/api/事件类型列表"))["事件类型列表"];
    for (const eventType of eventTypes) {
      const fields = (await post("/api/可筛选字段", { "事件类型": eventType }))["可筛选字段"];
      const candidatesByField = [];
      for (const field of fields) {
        const candidates = (await post("/api/字段候选值", { "事件类型": eventType, "字段": field }))["候选值"];
        if (candidates.length > 0) candidatesByField.push({ field, candidates });
        if (candidatesByField.length >= 2) {
          return {
            eventType,
            firstField: candidatesByField[0].field,
            firstValue: candidatesByField[0].candidates[0]["值"],
            secondField: candidatesByField[1].field,
            secondValue: candidatesByField[1].candidates[0]["值"],
          };
        }
      }
    }
    return null;
  });

  if (!scenario) {
    throw new Error("没有找到可复现的事件类型和筛选字段。");
  }

  await page.selectOption("#eventTypeSelect", scenario.eventType);
  await page.waitForSelector(".filter-row .filter-field", { timeout: 30000 });
  await page.selectOption(".filter-row .filter-field", scenario.firstField);
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector(".filter-row .filter-value");
      const datalist = document.getElementById(input.getAttribute("list"));
      return Array.from(datalist?.querySelectorAll("option") || []).some((option) => option.value === expected);
    },
    scenario.firstValue,
    { timeout: 30000 }
  );

  await page.fill(".filter-row .filter-value", scenario.firstValue);
  await page.selectOption(".filter-row .filter-field", scenario.secondField);
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector(".filter-row .filter-value");
      const datalist = document.getElementById(input.getAttribute("list"));
      return Array.from(datalist?.querySelectorAll("option") || []).some((option) => option.value === expected);
    },
    scenario.secondValue,
    { timeout: 30000 }
  );

  const requestCountBeforeFocus = candidateRequestCount;
  await page.click(".filter-row .filter-value");
  await page.click("body", { position: { x: 20, y: 20 } });
  await page.click(".filter-row .filter-value");
  await page.waitForTimeout(500);
  const requestCountAfterFocus = candidateRequestCount;

  const result = await page.evaluate((expectedSecondValue) => {
    const input = document.querySelector(".filter-row .filter-value");
    const listId = input.getAttribute("list");
    const datalist = document.getElementById(listId);
    const options = Array.from(datalist?.querySelectorAll("option") || []).map((option) => option.value);
    return {
      listId,
      hasRowScopedDatalist: listId !== "candidateList" && Boolean(datalist),
      inputValue: input.value,
      inputCleared: input.value === "",
      candidateUpdated: options.includes(expectedSecondValue),
      optionCount: options.length,
    };
  }, scenario.secondValue);

  console.log(
    JSON.stringify(
      {
        scenario,
        ...result,
        focusDidNotReloadCandidates: requestCountAfterFocus === requestCountBeforeFocus,
        requestCountBeforeFocus,
        requestCountAfterFocus,
        errors,
      },
      null,
      2
    )
  );
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
