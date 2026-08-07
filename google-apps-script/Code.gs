/**
 * Deploy this script from the target Google Sheet:
 * Extensions -> Apps Script -> paste -> Deploy -> New deployment -> Web app
 *
 * Execute as: Me
 * Who has access: Anyone
 *
 * After code changes: Deploy -> Manage deployments -> Edit -> New version -> Deploy
 */
function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "set_inprogress";
  const value = e && e.parameter && e.parameter.value ? e.parameter.value : "1";
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (action === "set_trigger") {
    const triggerRange = spreadsheet.getRangeByName("Trigger");

    if (!triggerRange) {
      return jsonResponse({
        success: false,
        error: "Named range Trigger was not found.",
      });
    }

    triggerRange.setValue(value);

    return jsonResponse({
      success: true,
      action: "set_trigger",
      range: "Trigger",
      value: value,
    });
  }

  if (action === "update_target") {
    const targetRange = spreadsheet.getRangeByName("Target");
    const triggerRange = spreadsheet.getRangeByName("Trigger");
    const inProgressRange = spreadsheet.getRangeByName("InProgress");

    if (!triggerRange || !inProgressRange) {
      return jsonResponse({
        success: false,
        error: "Named range Trigger or InProgress was not found.",
      });
    }

    if (targetRange) {
      targetRange.setValue(Number(value));
    }

    triggerRange.clearContent();
    inProgressRange.clearContent();

    return jsonResponse({
      success: true,
      action: "update_target",
      target: targetRange ? Number(value) : null,
      targetRangeFound: Boolean(targetRange),
      cleared: ["Trigger", "InProgress"],
    });
  }

  const range = spreadsheet.getRangeByName("InProgress");

  if (!range) {
    return jsonResponse({
      success: false,
      error: "Named range InProgress was not found.",
    });
  }

  range.setValue(value);

  return jsonResponse({
    success: true,
    action: "set_inprogress",
    range: "InProgress",
    value: value,
  });
}
