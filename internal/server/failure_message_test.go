package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestConciseFailureMessages(t *testing.T) {
	for _, item := range []struct {
		failure Failure
		want    string
	}{
		{Failure{Code: "3012", Message: strings.Repeat("blocked ", 1000)}, "上游风控拦截"},
		{Failure{Status: 403, Message: "Request has been blocked due to unusual activity."}, "上游风控拦截"},
		{Failure{Code: "upstream_waf_blocked"}, "上游安全网关拦截"},
		{Failure{Code: "insufficient_quota"}, "上游额度不足"},
		{Failure{Kind: "network", Message: "Post https://private.invalid?token=secret: EOF"}, "上游网络连接失败"},
		{Failure{Code: "upstream_stream_error", Message: "Post https://private.invalid?token=secret: EOF"}, "上游网络连接失败"},
		{Failure{Code: "captcha_verification_failed", Message: "上游安全验证未通过，需要按官方验证流程处理（F001）"}, "上游安全验证未通过（F001）"},
		{Failure{Code: "invalid_request_error", Message: "messages[0].content is required"}, "messages[0].content is required"},
	} {
		equal(t, conciseFailureMessage(&item.failure), item.want)
	}
	failure := &Failure{Code: "unknown", Message: strings.Repeat("未知错误\n\t ", 1000)}
	message := conciseFailureMessage(failure)
	if !utf8.ValidString(message) || len([]rune(message)) > 120 || strings.ContainsAny(message, "\n\t") {
		t.Fatal("unknown error was not bounded safely", message)
	}
	response := &http.Response{StatusCode: 405, Header: http.Header{"Server": {strings.Repeat("diagnostic ", 1000)}}}
	failure = upstreamHTTPFailure(response, []byte("<html>errors.aliyun.com/ block_message</html>"))
	equal(t, failure.Message, "上游安全网关拦截")
}

func TestUsageLogsSummarizeNewAndHistoricalErrors(t *testing.T) {
	a := testApp(t)
	raw := "request has been blocked due to unusual activity. " + strings.Repeat("details ", 1000)
	a.logUsage(inferOptions{ID: "new-request", Key: M{}, Body: M{}, Timing: newTiming()}, nil, &Failure{Code: "3012", Message: raw}, M{}, 1, nil)
	equal(t, a.row("SELECT error_message FROM usage_log WHERE request_id=?", "new-request")["error_message"], "上游风控拦截")
	must(t, a.exec("INSERT INTO usage_log(request_id,ts,status,error_code,error_message,trace_id) VALUES(?,?,?,?,?,?)", "old-request", nowMS(), "failed", "3012", raw, "original-trace"))
	value, status, err := a.adminRoute(httptest.NewRequest("GET", "/api/usage/logs", nil), nil)
	must(t, err)
	equal(t, status, 200)
	for _, value := range arr(value) {
		row := obj(value)
		equal(t, row["error_message"], "上游风控拦截")
		equal(t, row["error_code"], "3012")
		if row["request_id"] == "old-request" {
			equal(t, row["trace_id"], "original-trace")
		}
	}
	equal(t, a.row("SELECT error_message FROM usage_log WHERE request_id=?", "old-request")["error_message"], raw)
}
