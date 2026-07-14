const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Users/Stardust/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 820 } });
  const errors = [];
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("status of 404")) errors.push(text);
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
    const forbiddenShipNameTokens = ["航速", "航向", "船首向", "船艏向", "速度", "节", "°", "三无", "交通", "自备", "无名", "无证", "不知名", "散货", "海速"];
    const badBlacklistEntries = blacklist["黑名单条目"].filter((entry) =>
      forbiddenShipNameTokens.some((token) => String(entry["船名"] || "").includes(token)) ||
      /^x+$/i.test(String(entry["船名"] || "").trim())
    );
    const forbiddenExactNames = new Set([
      "运泥",
      "渔政",
      "蚝排",
      "海巡09222",
      "穗港引 16",
      "穗港消拖28",
      "穗港环保2",
      "穗港环保2号",
    ]);
    const publicServiceTokens = [
      "海巡",
      "海警",
      "渔政",
      "海监",
      "水警",
      "海关",
      "打私",
      "执法",
      "巡逻",
      "巡视",
      "消拖",
      "消防",
      "环保",
      "引航",
      "东海救",
      "南海救",
      "北海救",
      "护救",
    ];
    const forbiddenExactEntries = blacklist["黑名单条目"].filter((entry) => forbiddenExactNames.has(entry["船名"]));
    const publicServiceEntries = blacklist["黑名单条目"].filter((entry) => {
      const normalizedName = String(entry["船名"] || "").replace(/\s+/g, "");
      return publicServiceTokens.some((token) => normalizedName.includes(token)) || /港引\d/.test(normalizedName);
    });
    const retainedShipNames = ["粤新会货1336", "粤新会货8252", "SATSUKI", "振鹏", "粤阳东渔 12158"];
    const blacklistNameSet = new Set(blacklist["黑名单条目"].map((entry) => entry["船名"]));
    const missingRetainedShipNames = retainedShipNames.filter((name) => !blacklistNameSet.has(name));
    const entriesWithMmsi = blacklist["黑名单条目"].filter((entry) => Object.prototype.hasOwnProperty.call(entry, "MMSI"));
    const entriesWithConfidence = blacklist["黑名单条目"].filter((entry) =>
      Object.prototype.hasOwnProperty.call(entry, "置信度")
    );
    const entriesWithSourceEventCount = blacklist["黑名单条目"].filter((entry) =>
      Object.prototype.hasOwnProperty.call(entry, "来源事件数")
    );
    const shipNodesWithSourceEventCount = blacklist.staticNodes.filter(
      (node) => node.ontName === "船名" && String(node.description || "").includes("来源事件数")
    );
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
      badBlacklistEntries: badBlacklistEntries.slice(0, 10),
      forbiddenExactEntries: forbiddenExactEntries.slice(0, 10),
      publicServiceEntries: publicServiceEntries.slice(0, 10),
      publicServiceEntryCount: publicServiceEntries.length,
      missingRetainedShipNames,
      entriesWithMmsi: entriesWithMmsi.length,
      entriesWithConfidence: entriesWithConfidence.length,
      entriesWithSourceEventCount: entriesWithSourceEventCount.length,
      shipNodesWithSourceEventCount: shipNodesWithSourceEventCount.length,
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
  if (errors.length) {
    throw new Error(`页面控制台存在错误：${errors.join("; ")}`);
  }
  if (!apiChecks.hasAnyRequirementField || !apiChecks.hasSimulatedField || apiChecks.simulatedCandidateCount <= 0) {
    throw new Error("仿真字段没有出现在可查询字段和候选值中。");
  }
  if (apiChecks.typesWithAllRequirementFields !== 0 || apiChecks.maxRequirementFieldsPerType >= 14) {
    throw new Error("仿真字段分布过密，不能每个案例或事件类型都包含全部课题字段。");
  }
  if (
    apiChecks.badBlacklistEntries.length ||
    apiChecks.forbiddenExactEntries.length ||
    apiChecks.publicServiceEntryCount ||
    apiChecks.missingRetainedShipNames.length ||
    apiChecks.entriesWithMmsi ||
    apiChecks.entriesWithConfidence ||
    apiChecks.entriesWithSourceEventCount ||
    apiChecks.shipNodesWithSourceEventCount
  ) {
    throw new Error("黑名单仍包含伪船名、公共服务船、MMSI、置信度或来源事件数字段。");
  }
  if (!pageChecks.titleRemoved || pageChecks.metricType !== "违法船舶黑名单") {
    throw new Error("导出区域标题或黑名单图谱按钮状态不符合预期。");
  }
  if (blacklistDownload.suggestedFilename() !== "违法船舶黑名单.json" || fullDownload.suggestedFilename() !== "完整知识图谱.json") {
    throw new Error("下载按钮没有触发预期文件。");
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
