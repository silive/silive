# 部署指南

本文件是交接版部署说明，不包含任何真实密钥。

## 1. 环境要求

服务器建议：

- Ubuntu 22.04 LTS
- Node.js 20+
- MySQL 8+
- Nginx
- PM2
- HTTPS 证书

域名建议：

- 后台页面：`https://www.feichangjiandan.xyz`
- API：`https://api.feichangjiandan.xyz`

如果域名指向中国大陆服务器，小程序正式版通常需要完成 ICP 备案，并在微信公众平台配置合法域名。

## 2. 安装依赖

```bash
npm install
```

当前 `package.json`：

```json
{
  "scripts": {
    "cms": "node cms/server.js",
    "start": "node cms/server.js"
  },
  "dependencies": {
    "mysql2": "^3.11.5"
  }
}
```

## 3. 配置环境变量

复制示例：

```bash
cp .env.example .env
```

然后编辑 `.env`。

生产必须设置：

```env
NODE_ENV=production
PAY_MOCK=false
PUBLIC_BASE_URL=https://api.feichangjiandan.xyz
```

安全要求：

- `ADMIN_USER` 不要用 `admin`。
- `ADMIN_PASSWORD` 至少 16 位，包含大小写字母、数字和符号。
- `SESSION_SECRET` 至少 32 位随机字符串。
- `.env` 不得提交仓库，不得上传到小程序包。

## 4. MySQL

`.env` 中配置：

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=your_mysql_user
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=very_simple_custom
```

后端启动时会自动：

- 创建数据库。
- 创建表。
- 补充缺失列。
- 如果表为空，从 `cms/data/*.json` 初始化。

## 5. 微信小程序配置

`.env`：

```env
WECHAT_APPID=your_miniprogram_appid
WECHAT_SECRET=your_miniprogram_secret
```

小程序代码中 AppID 配置在：

- `project.config.json`
- `project.private.config.json`

不要在小程序前端写入 AppSecret。

## 6. 微信支付配置

`.env`：

```env
WECHAT_MCH_ID=your_mch_id
WECHAT_MCH_SERIAL_NO=your_mch_certificate_serial_no
WECHAT_PRIVATE_KEY_PATH=/absolute/path/to/apiclient_key.pem
WECHAT_API_V3_KEY=your_32_char_api_v3_key
WECHAT_PAY_NOTIFY_URL=https://api.feichangjiandan.xyz/api/pay/notify
WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_xxx
WECHAT_PAY_PUBLIC_KEY_PATH=/absolute/path/to/wechatpay_public_key.pem
```

注意：

- 商户私钥和证书不要放进项目仓库。
- 不要提交 `apiclient_key.pem`。
- 不要在日志里打印 APIv3 Key。

## 7. PM2 启动

示例：

```bash
pm2 start cms/server.js --name very-simple-cms
pm2 save
pm2 startup
```

查看日志：

```bash
pm2 logs very-simple-cms --lines 100
```

重启：

```bash
pm2 restart very-simple-cms
```

`.env` 修改后必须重启 Node/PM2 才会生效。

## 8. Nginx 反向代理

示例：

```nginx
server {
    listen 80;
    server_name api.feichangjiandan.xyz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.feichangjiandan.xyz;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

如果 Nginx 直接代理 `/uploads/` 静态文件，务必禁止脚本执行：

```nginx
location ~* ^/uploads/.*\.(php|phtml|phar|cgi|pl|py|sh|js|html|htm|svg|xml)$ {
    return 403;
}
```

## 9. 微信公众平台合法域名

小程序后台需要配置：

- request 合法域名：`https://api.feichangjiandan.xyz`
- uploadFile 合法域名：`https://api.feichangjiandan.xyz`
- downloadFile 合法域名：如需要预览后台资源，也加入 API 域名

如果使用备用香港 API：

- `https://hk-api.feichangjiandan.xyz`

也需要加入合法域名。

## 10. 上线前检查

```bash
node --check cms/server.js
curl https://api.feichangjiandan.xyz/api/health
curl https://api.feichangjiandan.xyz/api/home
curl https://api.feichangjiandan.xyz/api/products
```

检查项：

- `NODE_ENV=production`
- `PAY_MOCK=false`
- HTTPS 正常
- MySQL 连接正常
- API 返回正常
- 后台登录正常
- 上传正常
- 下单正常
- 微信支付回调可公网访问

## 11. 小程序发布注意

开发版：

- 可使用 `http://127.0.0.1:3000`
- 微信开发者工具需要勾选“不校验合法域名”

体验版/正式版：

- 必须使用 HTTPS 合法域名
- 不能依赖 127.0.0.1
- 不能使用 `PAY_MOCK=true`

## 12. 数据与文件备份

必须备份：

- MySQL 数据库
- `cms/uploads/`
- `.env`
- 微信支付证书文件
- Nginx 配置

不要把 `.env` 和证书发给不可信方。

