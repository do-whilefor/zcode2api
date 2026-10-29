package server

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestUsageChartRangeMatchesServerBuckets(t *testing.T) {
	a := testApp(t)
	before := nowMS()
	stats := a.usageStats(httptest.NewRequest("GET", "/api/usage/stats?hours=24", nil))
	end := integer(stats["range_end"])
	if end < before || end > nowMS() {
		t.Fatal("usage range does not describe the query time")
	}
	equal(t, end-integer(stats["range_start"]), 86400000)
	_, offset := time.UnixMilli(end).In(time.Local).Zone()
	equal(t, stats["utc_offset_minutes"], offset/60)
	equal(t, stats["time_unit"], "hour")
	equal(t, len(arr(stats["byHour"])), 0)
}
