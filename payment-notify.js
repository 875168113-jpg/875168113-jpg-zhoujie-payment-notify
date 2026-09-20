const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

// Cloud Run is outside the Cloud Functions runtime, so wx-server-sdk cannot
// infer credentials from DYNAMIC_CURRENT_ENV. The values are supplied as
// Cloud Run environment variables and never stored in the repository.
const cloudEnv = process.env.TCB_ENV || process.env.CLOUD_ENV || process.env.WECHAT_CLOUD_ENV || 'cloud1-d9grc4dta98de962f'
const secretId = process.env.TENCENTCLOUD_SECRETID || process.env.TCB_SECRET_ID || process.env.SECRET_ID
const secretKey = process.env.TENCENTCLOUD_SECRETKEY || process.env.TCB_SECRET_KEY || process.env.SECRET_KEY
const cloudConfig = { env: cloudEnv }
if (secretId && secretKey) Object.assign(cloudConfig, { secretId, secretKey })
cloud.init(cloudConfig)
function assertCloudCredentials() {
  if (!secretId || !secretKey) throw new Error('Cloud Run 缺少腾讯云凭证：请配置 TENCENTCLOUD_SECRETID 和 TENCENTCLOUD_SECRETKEY')
}
const db = cloud.database()

function cleanPem(value) { return String(value || '').replace(/\\n/g, '\n').trim() }
function response(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }
function rawBodyOf(event) {
  if (event && typeof event.rawBody === 'string') return event.rawBody
  const raw = event && event.body
  if (typeof raw === 'string') return event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw
  return JSON.stringify(raw || {})
}
function headersOf(event) {
  const output = {}
  for (const [key, value] of Object.entries((event && event.headers) || {})) output[String(key).toLowerCase()] = String(value || '')
  return output
}
function decryptText(resource) {
  const key = process.env.WECHAT_PAY_API_V3_KEY
  if (!key || Buffer.byteLength(key) !== 32) throw new Error('WECHAT_PAY_API_V3_KEY 必须为32字节')
  if (!resource || !resource.ciphertext || !resource.nonce) throw new Error('微信支付加密数据不完整')
  const ciphertext = Buffer.from(resource.ciphertext, 'base64')
  const authTag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(resource.nonce))
  decipher.setAuthTag(authTag)
  decipher.setAAD(Buffer.from(resource.associated_data || ''))
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
function decryptResource(resource) { return JSON.parse(decryptText(resource)) }
function merchantRequest(path) {
  const mchId = process.env.WECHAT_PAY_MCH_ID
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO
  const privateKey = cleanPem(process.env.WECHAT_PAY_PRIVATE_KEY)
  if (!mchId || !serialNo || !privateKey) throw new Error('微信支付商户参数未配置完整')
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const message = `GET\n${path}\n${timestamp}\n${nonceStr}\n\n`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64')
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.mch.weixin.qq.com', path, method: 'GET', headers: { Accept: 'application/json', Authorization: authorization, 'User-Agent': 'Jimujia-MiniProgram/1.0' } }, res => {
      let output = ''
      res.on('data', chunk => { output += chunk })
      res.on('end', () => {
        let result = {}
        try { result = JSON.parse(output) } catch (error) { return reject(new Error('微信支付查询结果无法解析')) }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(result.message || result.code || '微信支付查询失败'))
        resolve(result)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

let platformCertificates = { loadedAt: 0, rows: {} }
async function loadPlatformCertificates(force = false) {
  if (!force && Date.now() - platformCertificates.loadedAt < 12 * 60 * 60 * 1000 && Object.keys(platformCertificates.rows).length) return platformCertificates.rows
  const result = await merchantRequest('/v3/certificates')
  const rows = {}
  for (const item of result.data || []) {
    if (item.serial_no && item.encrypt_certificate) rows[String(item.serial_no).toUpperCase()] = decryptText(item.encrypt_certificate)
  }
  if (!Object.keys(rows).length) throw new Error('没有获取到微信支付平台证书')
  platformCertificates = { loadedAt: Date.now(), rows }
  return rows
}

async function verifyWechatPayNotice(event) {
  const headers = headersOf(event)
  const timestamp = headers['wechatpay-timestamp']
  const nonce = headers['wechatpay-nonce']
  const signature = headers['wechatpay-signature']
  const serial = String(headers['wechatpay-serial'] || '').toUpperCase()
  if (!timestamp || !nonce || !signature || !serial) {
    const error = new Error('支付通知缺少微信签名请求头')
    error.statusCode = 401
    throw error
  }
  const timestampNumber = Number(timestamp)
  if (!Number.isFinite(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 600) {
    const error = new Error('支付通知时间戳无效或已过期')
    error.statusCode = 401
    throw error
  }
  const rawBody = rawBodyOf(event)
  let certificates = await loadPlatformCertificates()
  let certificate = certificates[serial]
  if (!certificate) {
    certificates = await loadPlatformCertificates(true)
    certificate = certificates[serial]
  }
  if (!certificate) {
    const error = new Error('找不到支付通知对应的微信平台证书')
    error.statusCode = 401
    throw error
  }
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`
  const valid = crypto.verify('RSA-SHA256', Buffer.from(message), certificate, Buffer.from(signature, 'base64'))
  if (!valid) {
    const error = new Error('微信支付通知签名验证失败')
    error.statusCode = 401
    throw error
  }
  return JSON.parse(rawBody)
}

async function writePaymentLog(orderNo, error) {
  await db.collection('business_log').add({ data: {
    eventType: 'payment_notify_error', operation: 'paymentNotify', level: 'error', occurredAtMs: Date.now(), occurredAt: db.serverDate(), openid: '', memberCode: '', orderNo: String(orderNo || '').slice(0, 100), requestInput: { source: 'cloudrun-payment-notify' }, responseResult: { ok: false }, errorMessage: String((error && error.message) || error || '').slice(0, 2000), errorStack: String((error && error.stack) || error || '').slice(0, 12000), metadata: { source: 'cloudrun-payment-notify' }
  } }).catch(() => {})
}

exports.main = async event => {
  let orderNo = ''
  try {
    assertCloudCredentials()
    const notice = await verifyWechatPayNotice(event)
    if (!notice.resource) return response(400, { code: 'FAIL', message: '缺少支付通知数据' })
    const transaction = decryptResource(notice.resource)
    orderNo = String(transaction.out_trade_no || '').slice(0, 100)
    if (!orderNo) return response(400, { code: 'FAIL', message: '缺少订单号' })
    if (transaction.trade_state && transaction.trade_state !== 'SUCCESS') return response(200, { code: 'SUCCESS', message: '非成功交易无需更新' })
    const internalJobToken = String(process.env.INTERNAL_JOB_TOKEN || '').trim()
    if (internalJobToken.length < 32) throw new Error('INTERNAL_JOB_TOKEN 未配置或长度不足32位')
    const invoked = await cloud.callFunction({ name: 'commerce', data: { action: 'reconcileSinglePayment', op: 'reconcileSinglePayment', jimuAction: 'reconcileSinglePayment', trigger: 'payment-notify', internalJobToken, orderNo } })
    const synced = invoked && invoked.result
    if (!synced || !synced.ok) {
      if (synced && synced.error === '订单不存在') return response(200, { code: 'SUCCESS', message: '订单不存在，已忽略' })
      throw new Error((synced && synced.error) || '支付结果同步失败')
    }
    if (!synced.paid) throw new Error(`微信支付交易尚未成功：${synced.state || 'UNKNOWN'}`)
    return response(200, { code: 'SUCCESS', message: '成功' })
  } catch (error) {
    console.error('payment notification failed', error)
    await writePaymentLog(orderNo, error)
    return response(Number(error && error.statusCode) || 500, { code: 'FAIL', message: Number(error && error.statusCode) === 401 ? '支付通知验签失败' : '支付结果处理失败' })
  }
}
