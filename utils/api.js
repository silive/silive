const PROD_API_HOST = "https://api.feichangjiandan.xyz"
const PROD_BACKUP_API_HOST = "https://hk-api.feichangjiandan.xyz"
// 如果微信开发者工具无法访问 127.0.0.1，请改为本机局域网 IP，比如 http://192.168.1.8:3000
const LOCAL_API_BASE = "http://127.0.0.1:3000"
const LOCAL_DEV_API_HOST = LOCAL_API_BASE

function uniqueHosts(hosts) {
  return Array.from(new Set(hosts.filter(Boolean).map(host => String(host).replace(/\/$/, ""))))
}

function getStoredBackupHost() {
  try {
    const host = wx.getStorageSync("BACKUP_API_HOST")
    return /^https:\/\//.test(host) ? host : PROD_BACKUP_API_HOST
  } catch (error) {
    return PROD_BACKUP_API_HOST
  }
}

const PROD_API_HOSTS = uniqueHosts([PROD_API_HOST, getStoredBackupHost()])

function getEnvVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || "develop"
  } catch (error) {
    return "develop"
  }
}

function getDevApiHost() {
  try {
    const host = wx.getStorageSync("DEV_API_HOST")
    return /^https?:\/\//.test(host) ? host : LOCAL_DEV_API_HOST
  } catch (error) {
    return LOCAL_DEV_API_HOST
  }
}

const DEV_API_HOSTS = uniqueHosts([getDevApiHost()])
const API_HOSTS = getEnvVersion() === "release" ? PROD_API_HOSTS : DEV_API_HOSTS
const BASE_URL = API_HOSTS[0]
console.log("[api] baseURL=", BASE_URL)

function getActiveApiHost() {
  try {
    if (getEnvVersion() !== "release") return BASE_URL
    const active = wx.getStorageSync("ACTIVE_API_HOST")
    return API_HOSTS.includes(active) ? active : BASE_URL
  } catch (error) {
    return BASE_URL
  }
}

function setActiveApiHost(host) {
  if (!host) return
  try {
    wx.setStorageSync("ACTIVE_API_HOST", host)
  } catch (error) {}
}

function apiUrl(path, host = getActiveApiHost()) {
  return /^https?:\/\//.test(path) ? path : `${host}${path}`
}

function authHeader(extra = {}) {
  let userSession = ""
  try {
    userSession = wx.getStorageSync("userSession") || ""
  } catch (error) {
    userSession = ""
  }
  return userSession ? { "X-User-Session": userSession, ...extra } : extra
}

function request(path, options = {}) {
  const hosts = uniqueHosts(options.hosts || [getActiveApiHost(), ...API_HOSTS])
  const tried = []
  const tryHost = index => new Promise((resolve, reject) => {
    const host = hosts[index]
    if (!host) {
      reject(new Error(`接口不可访问：${tried.join("、") || "未配置API域名"}。请检查域名解析、HTTPS证书、微信request合法域名或切换备用API。`))
      return
    }
    const url = apiUrl(path, host)
    tried.push(host)
    console.log("[api] request url=", url)
    wx.request({
      url,
      method: options.method || "GET",
      data: options.data || {},
      header: authHeader(options.header || options.headers || {}),
      timeout: options.timeout || 10000,
      success: res => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          setActiveApiHost(host)
          resolve(res.data && res.data.ok === true && res.data.data !== undefined ? res.data.data : res.data)
          return
        }
        if (index < hosts.length - 1) {
          tryHost(index + 1).then(resolve).catch(reject)
          return
        }
        reject(new Error(res.data && res.data.message ? res.data.message : `接口请求失败：${res.statusCode} ${url}`))
      },
      fail: error => {
        console.error("[api] request failed:", url, error)
        if (index < hosts.length - 1) {
          tryHost(index + 1).then(resolve).catch(reject)
          return
        }
        reject(new Error(`${error.errMsg || "接口连接失败"}。当前API：${url}。可能原因：域名未解析/未备案拦截/HTTPS证书异常/未配置微信request合法域名。`))
      }
    })
  })
  return tryHost(0)
}

function requestPrimary(path, options = {}) {
  return request(path, options)
}

function checkApiConnectivity() {
  const hosts = uniqueHosts([getActiveApiHost(), ...API_HOSTS])
  const checks = hosts.map(host => new Promise(resolve => {
    wx.request({
      url: `${host}/api/health?t=${Date.now()}`,
      timeout: 6000,
      success: res => {
        const ok = res.statusCode >= 200 && res.statusCode < 300
        if (ok) setActiveApiHost(host)
        resolve({ host, ok, statusCode: res.statusCode, message: ok ? "连接正常" : `HTTP ${res.statusCode}` })
      },
      fail: error => resolve({ host, ok: false, statusCode: 0, message: error.errMsg || "连接失败" })
    })
  }))
  return Promise.all(checks).then(results => {
    const active = results.find(item => item.ok)
    if (active) return { ok: true, activeHost: active.host, results }
    return {
      ok: false,
      activeHost: "",
      results,
      message: "线上API不可访问，请检查域名解析、备案/接入、HTTPS证书和微信request合法域名。"
    }
  })
}

function uploadFileWithFallback(path, options = {}) {
  const hosts = uniqueHosts(options.hosts || [getActiveApiHost(), ...API_HOSTS])
  const tryHost = index => new Promise((resolve, reject) => {
    const host = hosts[index]
    if (!host) {
      reject(new Error("上传接口不可访问，请检查API域名或切换备用API"))
      return
    }
    wx.uploadFile({
      url: apiUrl(path, host),
      filePath: options.filePath,
      name: options.name || "file",
      header: authHeader(options.header || options.headers || {}),
      formData: options.formData || {},
      success: res => {
        let data = {}
        try {
          data = JSON.parse(res.data || "{}")
        } catch (error) {
          data = {}
        }
        const imageUrl = data.url || data.data?.url || ""
        if (res.statusCode >= 200 && res.statusCode < 300 && imageUrl) {
          setActiveApiHost(host)
          resolve({ ...data, url: imageUrl, statusCode: res.statusCode })
          return
        }
        if (index < hosts.length - 1) {
          tryHost(index + 1).then(resolve).catch(reject)
          return
        }
        reject(new Error(data.message || data.error || `上传失败：HTTP ${res.statusCode}`))
      },
      fail: error => {
        console.error("[api] upload failed:", apiUrl(path, host), error)
        if (index < hosts.length - 1) {
          tryHost(index + 1).then(resolve).catch(reject)
          return
        }
        reject(new Error(`${error.errMsg || "上传失败"}。请检查 uploadFile 合法域名和API连通性。`))
      }
    })
  })
  return tryHost(0)
}

module.exports = {
  BASE_URL,
  LOCAL_API_BASE,
  API_HOSTS,
  DEV_API_HOSTS,
  getEnvVersion,
  PROD_API_HOST,
  PROD_BACKUP_API_HOST,
  PROD_API_HOSTS,
  getActiveApiHost,
  setActiveApiHost,
  apiUrl,
  authHeader,
  request,
  requestPrimary,
  checkApiConnectivity,
  uploadFileWithFallback
}
