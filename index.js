const express = require('express')
// The Dockerfile places the handler under this path. Keeping the HTTP adapter
// separate lets the same handler run as a cloud function or Cloud Run service.
const paymentHandler = require('./payment-notify.js')

const app = express()
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer.toString('utf8') } }))
app.use(express.urlencoded({ extended: false }))

app.post('/pay/notify', async (req, res) => {
  try {
    const result = await paymentHandler.main({ body: req.body, rawBody: req.rawBody || JSON.stringify(req.body || {}), headers: req.headers || {} })
    const statusCode = Number(result && result.statusCode) || 200
    let body = result && result.body
    if (typeof body !== 'string') body = JSON.stringify(body || { code: 'SUCCESS', message: '成功' })
    res.status(statusCode).set(result && result.headers ? result.headers : {}).send(body)
  } catch (error) {
    console.error('payment notify http error', error)
    res.status(500).json({ code: 'FAIL', message: '支付结果处理失败' })
  }
})


app.get('/health', (_req, res) => res.json({ ok: true }))

const port = Number(process.env.PORT || 80)
app.listen(port, '0.0.0.0', () => console.log(`payment-notify listening on ${port}`))
