import {
  buildProratedTargetWriteRequest,
  prorateMonthlyValues,
  resolveTargetWriteIds,
  writeExpenseTarget,
} from "../src/planning-mcp-client.mjs";

const ids = {
  currencyId: "15400",
  versionId: "1188",
  timeId: "12007",
  accountId: "2943",
  levelId: "1",
  levelWriteId: "-1",
};

const monthlyValues = [
  { label: "Jan 2027", timeId: "144005", value: 3630000 },
  { label: "Feb 2027", timeId: "145005", value: 3580000 },
  { label: "Mar 2027", timeId: "146005", value: 4140000 },
  { label: "Apr 2027", timeId: "147005", value: 3900000 },
  { label: "May 2027", timeId: "148005", value: 3890000 },
  { label: "Jun 2027", timeId: "149005", value: 3920000 },
  { label: "Jul 2027", timeId: "150005", value: 3930000 },
  { label: "Aug 2027", timeId: "151005", value: 3910000 },
  { label: "Sep 2027", timeId: "152005", value: 3890000 },
  { label: "Oct 2027", timeId: "153005", value: 3840000 },
  { label: "Nov 2027", timeId: "154005", value: 3880000 },
  { label: "Dec 2027", timeId: "155005", value: 3890000 },
];

const { priorTotal, newTotal, prorated } = prorateMonthlyValues(monthlyValues, 47000000);
const request = buildProratedTargetWriteRequest(prorated, ids);
const writtenTotal = prorated.reduce((sum, month) => sum + month.value, 0);

if (priorTotal !== 46400000) {
  throw new Error(`Unexpected prior total: ${priorTotal}`);
}

if (newTotal !== 47000000 || writtenTotal !== 47000000) {
  throw new Error(`Prorated values do not sum to the new target: ${writtenTotal}`);
}

if (request.indexedCoordinates.length !== 12) {
  throw new Error("Expected 12 monthly coordinates in the write request.");
}

console.log("prorateMonthlyValues:", { priorTotal, newTotal, writtenTotal });
console.log("buildProratedTargetWriteRequest:", JSON.stringify(request, null, 2));

if (process.argv.includes("--live")) {
  const resolvedIds = await resolveTargetWriteIds();
  console.log("resolvedIds:", resolvedIds);
  const result = await writeExpenseTarget(47000000, resolvedIds);
  console.log("writeExpenseTarget:", {
    priorTotal: result.priorTotal,
    newTotal: result.newTotal,
    response: result.response,
    months: result.monthlyValues,
  });
}
