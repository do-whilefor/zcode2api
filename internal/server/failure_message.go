package server

import "strings"

// Use the same bounded summary for gateway errors, new logs and historical logs.
// Codes and request/trace IDs remain separate fields for diagnosis.
func conciseFailureMessage(f *Failure) string {
	copy := *f
	classify(&copy)
	switch copy.Code {
	case "upstream_waf_blocked":
		return "上游安全网关拦截"
	case "captcha_expired", "captcha_invalid":
		return "验证码已失效，请重新验证"
	case "captcha_duplicate_result":
		return "验证码票据重复，请重新验证"
	case "proxy_auth_failed":
		return "代理鉴权失败"
	case "captcha_verification_failed":
		// Keep the short SDK diagnostic code without the explanatory paragraph.
		if index := strings.LastIndex(copy.Message, "（F"); index >= 0 {
			code := strings.TrimSuffix(strings.TrimPrefix(copy.Message[index:], "（"), "）")
			if len(code) == 4 && code[0] == 'F' && code[1] >= '0' && code[1] <= '9' && code[2] >= '0' && code[2] <= '9' && code[3] >= '0' && code[3] <= '9' {
				return "上游安全验证未通过（" + code + "）"
			}
		}
		return "上游安全验证未通过"
	}
	switch copy.Kind {
	case "risk":
		return "上游风控拦截"
	case "auth":
		return "上游鉴权失败，请重新登录"
	case "quota":
		return "上游额度不足"
	case "permission":
		return "上游拒绝访问"
	case "rate_limit":
		return "上游请求限流"
	case "busy":
		return "上游并发已满"
	case "overload":
		return "上游服务过载"
	case "network":
		return "上游网络连接失败"
	case "context":
		return "上下文超出模型限制"
	}
	message := strings.Join(strings.Fields(copy.Message), " ")
	if message == "" {
		return "上游请求失败"
	}
	runes := []rune(message)
	if len(runes) > 120 {
		return string(runes[:119]) + "…"
	}
	return message
}

func riskBlockMessage(message string) bool {
	message = strings.ToLower(message)
	return strings.Contains(message, "request has been blocked due to unusual") ||
		strings.Contains(message, "request blocked due to unusual")
}
