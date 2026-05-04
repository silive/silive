# 环境变量示例

本文件是交接说明，不包含真实密钥。请不要把真实 `.env` 内容写入文档或提交仓库。

## 1. 本地开发示例

```env
PORT=3000
PUBLIC_BASE_URL=http://127.0.0.1:3000
NODE_ENV=development

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=very_simple_custom

ADMIN_USER=your_admin_username
ADMIN_PASSWORD=replace_with_a_16_plus_char_strong_password
SESSION_SECRET=replace_with_a_32_plus_char_random_secret

WECHAT_APPID=your_miniprogram_appid
WECHAT_SECRET=your_miniprogram_secret

WECHAT_MCH_ID=your_mch_id
WECHAT_MCH_SERIAL_NO=your_mch_certificate_serial_no
WECHAT_PRIVATE_KEY_PATH=/absolute/path/to/apiclient_key.pem
WECHAT_API_V3_KEY=your_32_char_api_v3_key
WECHAT_PAY_NOTIFY_URL=https://your-domain.com/api/pay/notify
WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_xxx
WECHAT_PAY_PUBLIC_KEY_PATH=/absolute/path/to/wechatpay_public_key.pem

PAY_MOCK=true
```

## 2. 生产环境示例

```env
PORT=3000
PUBLIC_BASE_URL=https://api.feichangjiandan.xyz
NODE_ENV=production

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=very_simple_app
MYSQL_PASSWORD=replace_with_real_strong_mysql_password
MYSQL_DATABASE=very_simple_custom

ADMIN_USER=replace_with_non_admin_username
ADMIN_PASSWORD=replace_with_16_plus_char_password_with_upper_lower_digit_symbol
SESSION_SECRET=replace_with_32_plus_char_random_secret

WECHAT_APPID=your_miniprogram_appid
WECHAT_SECRET=your_miniprogram_secret

WECHAT_MCH_ID=your_mch_id
WECHAT_MCH_SERIAL_NO=your_mch_certificate_serial_no
WECHAT_PRIVATE_KEY_PATH=/secure/path/apiclient_key.pem
WECHAT_API_V3_KEY=your_32_char_api_v3_key
WECHAT_PAY_NOTIFY_URL=https://api.feichangjiandan.xyz/api/pay/notify
WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_xxx
WECHAT_PAY_PUBLIC_KEY_PATH=/secure/path/wechatpay_public_key.pem

PAY_MOCK=false
```

## 3. 变量说明

### 服务

- `PORT`：Node HTTP 端口，默认 3000。
- `PUBLIC_BASE_URL`：公开 API 和资源访问地址。生产必须是 HTTPS。
- `NODE_ENV`：生产必须为 `production`。

### 数据库

- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`

如果后端无法加载 `mysql2` 或数据库不可用，本地可能回退 JSON 存储。生产不建议回退 JSON。

### 后台管理员

- `ADMIN_USER`：后台管理员账号。代码读取的是 `ADMIN_USER`，不是 `ADMIN_USERNAME`。
- `ADMIN_PASSWORD`：后台管理员密码。
- `SESSION_SECRET`：session 安全随机串。

生产要求：

- `ADMIN_USER` 不能是 `admin`。
- `ADMIN_PASSWORD` 至少 16 位。
- `SESSION_SECRET` 至少 32 位，不能是示例值。

### 微信小程序

- `WECHAT_APPID`
- `WECHAT_SECRET`

注意：`WECHAT_SECRET` 只能放后端 `.env`，不能写到小程序前端。

### 微信支付

- `WECHAT_MCH_ID`
- `WECHAT_MCH_SERIAL_NO`
- `WECHAT_PRIVATE_KEY_PATH`
- `WECHAT_API_V3_KEY`
- `WECHAT_PAY_NOTIFY_URL`
- `WECHAT_PAY_PUBLIC_KEY_ID`
- `WECHAT_PAY_PUBLIC_KEY_PATH`

证书和私钥文件必须放在服务器安全目录，不能放入小程序包或公开目录。

### 支付模式

- `PAY_MOCK=true`：仅本地开发可用。
- `PAY_MOCK=false`：生产必须使用。

生产环境如果 `PAY_MOCK=true`，服务会拒绝启动。

## 4. 修改后是否需要重启

`.env` 是 Node 服务启动时读取的。

修改 `.env` 后必须重启：

```bash
pm2 restart very-simple-cms
```

本地开发：

```bash
npm start
```

或停止旧进程后重新执行：

```bash
node cms/server.js
```

