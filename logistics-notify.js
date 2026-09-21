const cloud = require('wx-server-sdk')
const crypto = require('crypto')

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

const ORDERS = 'commerce_orders'
const LOGISTICS = 'order_logistics'
const ERRORS = 'system_error_logs'

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max)
}

function md5Upper(text) {
  return crypto.createHash('md5').update(String(text || ''), 'utf8').digest('hex').toUpperCase()
}

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function decodeBody(event) {
  if (!event) return ''
  const raw = event.body != null ? event.body : event
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw
  return event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : String(raw || '')
}

function parseBody(event) {
  const decoded = decodeBody(event)
  if (decoded && typeof decoded === 'object') return { notice: decoded, rawParam: typeof decoded.param === 'string' ? decoded.param : '' }
  const source = String(decoded || '').trim()
  if (!source) return { notice: {}, rawParam: '' }
  try {
    const json = JSON.parse(source)
    return { notice: json, rawParam: typeof json.param === 'string' ? json.param : '' }
  } catch (error) {}
  const params = new URLSearchParams(source)
  const notice = {}
  params.forEach((value, key) => { notice[key] = value })
  return { notice, rawParam: notice.param || '' }
}

function logisticsStateText(state) {
  return ({ '0': '在途', '1': '已揽收', '2': '疑难件', '3': '已签收', '4': '退签', '5': '派件中', '6': '退回', '10': '待清关', '14': '拒签' })[String(state)] || '已发货'
}

function nodeKey(orderNo, trackingNo, time, context) {
  return md5Upper(`${orderNo}|${trackingNo}|${time}|${context}`).slice(0, 32)
}

function tracesFromLastResult(lastResult) {
  const data = (lastResult && lastResult.data) || []
  return (Array.isArray(data) ? data : []).map(row => ({
    time: clean(row.ftime || row.time, 40),
    context: clean(row.context || row.status || row.desc, 300),
    location: clean(row.location || row.areaName || '', 80)
  })).filter(row => row.time || row.context)
}

async function ensureCollection(name) {
  try {
    await db.collection(name).limit(1).get()
    return true
  } catch (error) {
    await db.createCollection(name).catch(() => {})
    return true
  }
}

async function writeError(row) {
  try {
    await ensureCollection(ERRORS)
    await db.collection(ERRORS).add({
      data: {
        source: 'kuaidi100-callback',
        orderNo: clean(row.orderNo, 100),
        trackingNo: clean(row.trackingNo, 100),
        message: clean(row.message, 300),
        detail: clean(row.detail, 500),
        createdAt: db.serverDate(),
        createdAtText: new Date().toISOString()
      }
    })
  } catch (error) {
    console.error('logistics callback log failed', error && error.message)
  }
}

async function persistTraces(order, lastResult) {
  await ensureCollection(LOGISTICS)
  const trackingNo = clean((lastResult && lastResult.nu) || order.trackingNo, 100)
  const expressCode = clean((lastResult && lastResult.com) || order.carrierCode, 30)
  const traces = tracesFromLastResult(lastResult)
  for (const trace of traces) {
    const fingerprint = nodeKey(order.orderNo, trackingNo, trace.time, trace.context)
    const existing = await db.collection(LOGISTICS).where({ fingerprint }).limit(1).get().catch(() => ({ data: [] }))
    if (existing.data && existing.data.length) continue
    await db.collection(LOGISTICS).add({
      data: {
        order_id: order.orderNo,
        orderNo: order.orderNo,
        express_no: trackingNo,
        express_code: expressCode,
        logistics_time: trace.time,
        logistics_desc: trace.context,
        location: trace.location,
        fingerprint,
        create_time: db.serverDate(),
        createdAtText: new Date().toISOString()
      }
    })
  }
  const latest = traces[0] || {}
  const state = logisticsStateText(lastResult && lastResult.state)
  await db.collection(ORDERS).doc(order._id).update({
    data: {
      shippingState: state,
      logisticsMessage: traces.length ? '已收到快递100物流推送' : '暂无物流信息，请稍后再查看',
      logisticsProvider: 'kuaidi100',
      shippingTraces: traces,
      latestTraceText: [latest.time, latest.location, latest.context].filter(Boolean).join(' · '),
      logisticsQueriedAtMs: Date.now(),
      updatedAt: db.serverDate()
    }
  }).catch(() => {})
  return traces.length
}

exports.main = async event => {
  try {
    assertCloudCredentials()
    const parsed = parseBody(event)
    const notice = parsed.notice || {}
    const paramText = parsed.rawParam || (typeof notice.param === 'string' ? notice.param : '')
    let payload = notice
    if (paramText) {
      try { payload = JSON.parse(paramText) } catch (error) { payload = notice }
    } else if (notice.param && typeof notice.param === 'object') {
      payload = notice.param
    }
    const lastResult = payload.lastResult || payload.last_result || payload
    const trackingNo = clean((lastResult && lastResult.nu) || payload.nu || payload.number, 100)
    const sign = clean(notice.sign || payload.sign, 80)
    if (!trackingNo) {
      await writeError({ message: '回调缺少运单号', detail: String(paramText || '').slice(0, 200) })
      return response(200, { result: false, returnCode: '500', message: '缺少运单号' })
    }
    const orders = await db.collection(ORDERS).where({ trackingNo }).limit(5).get()
    if (!orders.data.length) {
      await writeError({ trackingNo, message: '找不到对应订单' })
      return response(200, { result: true, returnCode: '200', message: '成功' })
    }
    const order = orders.data[0]
    const salt = clean(order.kuaidi100Salt, 40)
    // 每次发货都会生成订单级 salt。没有 salt 的历史订单不能安全验证回调，
    // 必须拒绝写入，避免仅凭运单号伪造物流轨迹。
    if (!salt) {
      await writeError({ orderNo: order.orderNo, trackingNo, message: '订单缺少物流回调签名盐值，已拒绝回调' })
      return response(200, { result: false, returnCode: '500', message: '订单签名配置缺失' })
    }
    const expected = md5Upper((paramText || JSON.stringify(payload)) + salt)
    if (!sign || expected !== sign.toUpperCase()) {
      await writeError({ orderNo: order.orderNo, trackingNo, message: '快递100回调签名校验失败' })
      return response(200, { result: false, returnCode: '500', message: '签名校验失败' })
    }
    await persistTraces(order, lastResult)
    return response(200, { result: true, returnCode: '200', message: '成功' })
  } catch (error) {
    console.error('kuaidi100 callback failed', error)
    await writeError({ message: error && error.message, detail: 'callback-exception' })
    return response(200, { result: false, returnCode: '500', message: '处理失败' })
  }
}
