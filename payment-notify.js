const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function cleanPem(value) { return String(value || '').replace(/\\n/g, '\n').trim() }
function response(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }
function bodyOf(event) {
  const raw = event && event.body
  if (!raw) return event || {}
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString() : raw
  return typeof text === 'string' ? JSON.parse(text) : text
}
function decryptResource(resource) {
  const key = process.env.WECHAT_PAY_API_V3_KEY
  if (!key || Buffer.byteLength(key) !== 32) throw new Error('WECHAT_PAY_API_V3_KEY 必须为32字节')
  const ciphertext = Buffer.from(resource.ciphertext, 'base64')
  const authTag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(resource.nonce))
  decipher.setAuthTag(authTag)
  decipher.setAAD(Buffer.from(resource.associated_data || ''))
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString())
}
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

exports.main = async event => {
  try {
    const notice = bodyOf(event)
    if (!notice.resource) return response(400, { code: 'FAIL', message: '缺少支付通知数据' })
    const transaction = decryptResource(notice.resource)
    const orderNo = String(transaction.out_trade_no || '').slice(0, 100)
    if (!orderNo) return response(400, { code: 'FAIL', message: '缺少订单号' })
    const orders = await db.collection('commerce_orders').where({ orderNo }).limit(1).get()
    if (!orders.data.length) return response(200, { code: 'SUCCESS', message: '成功' })
    const order = orders.data[0]
    const mchId = process.env.WECHAT_PAY_MCH_ID
    const verified = await merchantRequest(`/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(mchId)}`)
    if (verified.trade_state !== 'SUCCESS') return response(400, { code: 'FAIL', message: '交易尚未成功' })
    if (Number(verified.amount && verified.amount.total) !== Number(order.payableCents)) return response(400, { code: 'FAIL', message: '订单金额不一致' })
    if (!['paid', 'shipped', 'completed'].includes(order.status)) {
      await db.collection('commerce_orders').doc(order._id).update({ data: { status: 'paid', statusText: '待发货', transactionId: verified.transaction_id || '', paidAt: db.serverDate(), updatedAt: db.serverDate() } })
    }
    return response(200, { code: 'SUCCESS', message: '成功' })
  } catch (error) {
    console.error('payment notification failed', error)
    return response(500, { code: 'FAIL', message: '支付结果处理失败' })
  }
}
