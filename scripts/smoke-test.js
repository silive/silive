#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3000"
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 10000)

function argValue(name) {
  const prefix = `${name}=`
  const matched = process.argv.slice(2).find(arg => arg.startsWith(prefix))
  if (matched) return matched.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ""
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "")
}

const baseUrl = normalizeBaseUrl(argValue("--base-url") || process.env.BASE_URL)

async function request(path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: { "user-agent": "very-simple-smoke-test/1.0", "cache-control": "no-cache", connection: "close", ...(options.headers || {}) },
      redirect: options.redirect || "manual",
      signal: controller.signal
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: response.status, ok: response.ok, text, json, headers: response.headers }
  } finally {
    clearTimeout(timer)
  }
}

function includesAny(text, words) {
  return words.some(word => String(text || "").includes(word))
}

function pass(message = "") {
  return { ok: true, message }
}

function fail(message) {
  return { ok: false, message }
}

const checks = [
  {
    name: "健康检查 /api/health",
    path: "/api/health",
    verify: result => result.status === 200 && result.json?.ok === true
      ? pass(`status=${result.status}`)
      : fail(`期望 200 且 ok=true，实际 status=${result.status}`)
  },
  {
    name: "首页数据 /api/home",
    path: "/api/home",
    verify: result => result.status === 200 && result.json && typeof result.json === "object"
      ? pass(`status=${result.status}`)
      : fail(`期望 200 且返回 JSON，实际 status=${result.status}`)
  },
  {
    name: "商品列表 /api/products",
    path: "/api/products",
    verify: result => result.status === 200 && (Array.isArray(result.json) || Array.isArray(result.json?.data))
      ? pass(`status=${result.status}`)
      : fail(`期望 200 且返回商品数组，实际 status=${result.status}`)
  },
  {
    name: "后台页面 /admin",
    path: "/admin",
    verify: result => {
      if (result.status === 200 && includesAny(result.text, ["非常智造管理后台", "商品中心", "系统设置"])) {
        return pass(`status=${result.status}`)
      }
      const location = result.headers.get("location") || ""
      if ([301, 302, 303, 307, 308].includes(result.status) && location.includes("/login")) {
        return pass(`未登录跳转 ${location}`)
      }
      return fail(`期望 200 后台 HTML 或跳转登录页，实际 status=${result.status}`)
    }
  },
  {
    name: "业务员登录页 /sales/login",
    path: "/sales/login",
    verify: result => result.status === 200 && includesAny(result.text, ["业务员登录", "非常智造业务员工作台"])
      ? pass(`status=${result.status}`)
      : fail(`期望 200 且返回业务员登录页，实际 status=${result.status}`)
  },
  {
    name: "门店身份 /api/store/me 未登录",
    path: "/api/store/me",
    verify: result => result.status === 200 && result.json?.ok === true && result.json?.bound === false
      ? pass("未登录返回 ok=true,bound=false")
      : fail(`期望未登录返回 ok=true,bound=false，实际 status=${result.status}, body=${JSON.stringify(result.json)}`)
  },
  {
    name: "业务员门店线索 /api/sales/store-leads 未登录拦截",
    path: "/api/sales/store-leads",
    verify: result => result.status === 401
      ? pass("未登录返回 401")
      : fail(`期望 401，实际 status=${result.status}`)
  },
  {
    name: "后台推广循环检测 /api/admin/promotion-relations/cycles 未登录拦截",
    path: "/api/admin/promotion-relations/cycles",
    verify: result => result.status === 401
      ? pass("未登录返回 401")
      : fail(`期望 401，实际 status=${result.status}`)
  }
]

async function run() {
  console.log(`非常智造冒烟测试`)
  console.log(`BASE_URL: ${baseUrl}`)
  console.log("")

  const results = []
  for (const check of checks) {
    try {
      const result = await request(check.path, check)
      const verified = check.verify(result)
      results.push({ ...check, ...verified, status: result.status })
      console.log(`${verified.ok ? "PASS" : "FAIL"} ${check.name}${verified.message ? ` - ${verified.message}` : ""}`)
    } catch (error) {
      const message = error.name === "AbortError" ? `请求超时 ${TIMEOUT_MS}ms` : error.message
      results.push({ ...check, ok: false, message })
      console.log(`FAIL ${check.name} - ${message}`)
    }
  }

  const passed = results.filter(item => item.ok).length
  const failed = results.length - passed
  console.log("")
  console.log(`结果: ${passed}/${results.length} 通过，${failed} 失败`)

  if (failed > 0) {
    console.log("")
    console.log("失败项:")
    results.filter(item => !item.ok).forEach(item => {
      console.log(`- ${item.name}: ${item.message}`)
    })
    process.exitCode = 1
  }
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
