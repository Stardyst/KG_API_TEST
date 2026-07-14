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
    const text = message.text();
    if (message.type() === "error" && !text.includes("status of 404")) errors.push(text);
  });
  page.on("request", (request) => {
    if (decodeURI(request.url()).includes("/api/字段候选值")) candidateRequestCount += 1;
  });

  await page.goto("http://127.0.0.1:8010/?repro=filter-candidates", { waitUntil: "networkidle" });
  await page.waitForSelector(".filter-row .filter-field", { timeout: 30000 });

  const scenario = await page.evaluate(async () => {
    const requirementFields = new Set(["船东", "船舶管理公司人员", "船舶驾引人员", "船上乘客", "工程船", "交通流量", "交通流分布", "气象", "水文", "港口", "航道", "锚地", "渔区", "地方条例"]);
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
      let candidatesByField = [];
      for (const field of fields) {
        const candidates = (await post("/api/字段候选值", { "事件类型": eventType, "字段": field }))["候选值"];
        if (candidates.length > 0) candidatesByField.push({ field, candidates });
      }
      const requirementCandidates = candidatesByField.filter((item) => requirementFields.has(item.field));
      if (requirementCandidates.length >= 2) {
        candidatesByField = requirementCandidates;
      }
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
      const menu = document.querySelector(".filter-row .filter-candidate-menu");
      return Array.from(menu?.querySelectorAll(".filter-candidate-option") || []).some(
        (option) => option.dataset.value === expected
      );
    },
    scenario.firstValue,
    { timeout: 30000 }
  );

  await page.fill(".filter-row .filter-value", scenario.firstValue);
  const requestCountBeforeQuery = candidateRequestCount;
  await page.click("#queryButton");
  await page.waitForFunction(() => {
    const button = document.querySelector("#queryButton");
    return button && !button.disabled && button.textContent === "查询图谱";
  });
  const requestCountAfterQuery = candidateRequestCount;
  const requestCountBeforePostQuerySwitch = candidateRequestCount;
  await page.selectOption(".filter-row .filter-field", scenario.secondField);
  await page.waitForFunction(
    (expected) => {
      const menu = document.querySelector(".filter-row .filter-candidate-menu");
      return Array.from(menu?.querySelectorAll(".filter-candidate-option") || []).some(
        (option) => option.dataset.value === expected
      );
    },
    scenario.secondValue,
    { timeout: 30000 }
  );
  const requestCountAfterPostQuerySwitch = candidateRequestCount;

  const requestCountBeforeFocus = candidateRequestCount;
  await page.click(".filter-row .filter-value");
  await page.waitForSelector(".filter-candidate-menu:not([hidden])", { timeout: 30000 });
  await page.waitForTimeout(200);
  const requestCountAfterFocus = candidateRequestCount;
  const result = await page.evaluate((expectedSecondValue) => {
    const input = document.querySelector(".filter-row .filter-value");
    const menus = Array.from(document.querySelectorAll(".filter-candidate-menu:not([hidden])"));
    const options = Array.from(menus[0]?.querySelectorAll(".filter-candidate-option") || []).map(
      (option) => option.dataset.value
    );
    return {
      visibleCandidateMenus: menus.length,
      inputValue: input.value,
      inputCleared: input.value === "",
      candidateUpdated: options.includes(expectedSecondValue),
      optionCount: options.length,
    };
  }, scenario.secondValue);
  await page.locator(".filter-candidate-option").filter({ hasText: scenario.secondValue }).first().click();
  const selectionResult = await page.evaluate((expectedSecondValue) => ({
    candidateSelected: document.querySelector(".filter-row .filter-value")?.value === expectedSecondValue,
    menuClosedAfterSelection: document.querySelector(".filter-row .filter-candidate-menu")?.hidden === true,
  }), scenario.secondValue);

  await page.selectOption(".filter-row .filter-field", scenario.firstField);
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector(".filter-row .filter-value");
      const menu = document.querySelector(".filter-row .filter-candidate-menu");
      return input.value === "" && Array.from(menu?.querySelectorAll(".filter-candidate-option") || []).some((option) => option.dataset.value === expected);
    },
    scenario.firstValue,
    { timeout: 30000 }
  );
  const switchedBack = await page.evaluate((expectedFirstValue) => {
    const input = document.querySelector(".filter-row .filter-value");
    const menu = document.querySelector(".filter-row .filter-candidate-menu");
    const options = Array.from(menu?.querySelectorAll(".filter-candidate-option") || []).map((option) => option.dataset.value);
    return input.value === "" && options.includes(expectedFirstValue);
  }, scenario.firstValue);

  console.log(
    JSON.stringify(
      {
        scenario,
        ...result,
        ...selectionResult,
        focusDidNotReloadCandidates: requestCountAfterFocus === requestCountBeforeFocus,
        switchedBack,
        queryDidNotReloadCandidates: requestCountAfterQuery === requestCountBeforeQuery,
        postQuerySwitchRequestCount: requestCountAfterPostQuerySwitch - requestCountBeforePostQuerySwitch,
        requestCountBeforeFocus,
        requestCountAfterFocus,
        errors,
      },
      null,
      2
    )
  );
  if (errors.length) {
    throw new Error(`页面控制台存在错误：${errors.join("; ")}`);
  }
  if (
    result.visibleCandidateMenus !== 1 ||
    !result.inputCleared ||
    !result.candidateUpdated ||
    !selectionResult.candidateSelected ||
    !selectionResult.menuClosedAfterSelection ||
    !switchedBack
  ) {
    throw new Error("筛选条件切换后，筛选值候选列表没有按当前字段刷新。");
  }
  if (requestCountAfterFocus !== requestCountBeforeFocus) {
    throw new Error("点击筛选值输入框不应再次请求候选值，当前可能导致候选框重复弹出。");
  }
  if (requestCountAfterQuery !== requestCountBeforeQuery || requestCountAfterPostQuerySwitch - requestCountBeforePostQuerySwitch !== 1) {
    throw new Error("查询图谱后切换筛选字段时，候选值没有保持单次刷新。");
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
