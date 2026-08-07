/**
 * Deploy this script from the target Google Sheet:
 * Extensions -> Apps Script -> paste -> Deploy -> New deployment -> Web app
 *
 * Execute as: Me
 * Who has access: Anyone
 *
 * Then set GOOGLE_SHEETS_WEBAPP_URL in the MCP server env to the deployment URL.
 */
function doGet(e) {
  const value = e && e.parameter && e.parameter.value ? e.parameter.value : "1";
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const range = spreadsheet.getRangeByName("InProgress");

  if (!range) {
  return ContentService.createTextOutput(
    JSON.stringify({
      success: false,
      error: "Named range InProgress was not found.",
    }),
  ).setMimeType(ContentService.MimeType.JSON);
  }

  range.setValue(value);

  return ContentService.createTextOutput(
    JSON.stringify({
      success: true,
      range: "InProgress",
      value: value,
    }),
  ).setMimeType(ContentService.MimeType.JSON);
}
