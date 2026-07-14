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

  await page.goto("http://127.0.0.1:8010/?repro=export-blacklist-simulation", { waitUntil: "networkidle" });
  await page.waitForSelector("#fullExportButton", { timeout: 30000 });

  const apiChecks = await page.evaluate(async () => {
    async function post(path, body = {}) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    }
    async function get(path) {
      const response = await fetch(path);
      return response.json();
    }

    const requiredFields = ["船东", "船舶管理公司人员", "船舶驾引人员", "船上乘客", "工程船", "交通流量", "交通流分布", "气象", "水文", "港口", "航道", "锚地", "渔区", "地方条例"];
    const allTypes = (await post("/api/事件类型列表"))["事件类型列表"];
    const fieldLists = [];
    for (const eventType of allTypes) {
      const fields = await post("/api/可筛选字段", { "事件类型": eventType });
      fieldLists.push({ eventType, fields: fields["可筛选字段"] });
    }
    const carrier = fieldLists.find((item) => item.fields.includes("交通流量")) || fieldLists.find((item) => item.fields.some((field) => requiredFields.includes(field)));
    const queryField = carrier.fields.find((field) => requiredFields.includes(field));
    const candidates = await post("/api/字段候选值", { "事件类型": carrier.eventType, "字段": queryField });
    const simulatedQuery = await post("/api/知识图谱查询", {
      "事件类型": carrier.eventType,
      "筛选条件": { [queryField]: candidates["候选值"][0]["值"] },
    });
    const blacklist = await get("/api/黑名单图谱");
    const fullResponse = await fetch("/api/全量知识图谱下载");
    const contentLength = Number(fullResponse.headers.get("Content-Length") || 0);
    fullResponse.body?.cancel();

    return {
      pageFieldCheck: { eventType: carrier.eventType, field: queryField },
      maxRequirementFieldsPerType: Math.max(...fieldLists.map((item) => item.fields.filter((field) => requiredFields.includes(field)).length)),
      typesWithAllRequirementFields: fieldLists.filter((item) => requiredFields.every((field) => item.fields.includes(field))).length,
      hasAnyRequirementField: fieldLists.some((item) => item.fields.some((field) => requiredFields.includes(field))),
      hasSimulatedField: Boolean(queryField),
      simulatedCandidateCount: candidates["候选值"].length,
      simulatedQueryEvents: simulatedQuery["命中事件数"],
      blacklistNodes: blacklist["节点数"],
      blacklistLinks: blacklist["关系数"],
      blacklistEntries: blacklist["黑名单条目"].length,
      fullExportContentLength: contentLength,
    };
  });

  await page.click("#blacklistButton");
  await page.waitForFunction(() => document.querySelector("#metricType")?.textContent === "违法船舶黑名单", {
    timeout: 30000,
  });
  const pageChecks = await page.evaluate(() => ({
    titleRemoved: !document.body.textContent.includes("导出与专题图谱"),
    metricType: document.querySelector("#metricType")?.textContent,
    graphInfo: document.querySelector("#graphInfo")?.textContent || "",
  }));

  const [blacklistDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.click("#blacklistDownloadButton"),
  ]);
  const [fullDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.click("#fullExportButton"),
  ]);

  console.log(
    JSON.stringify(
      {
        ...apiChecks,
        ...pageChecks,
        blacklistDownloadName: blacklistDownload.suggestedFilename(),
        fullDownloadName: fullDownload.suggestedFilename(),
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
