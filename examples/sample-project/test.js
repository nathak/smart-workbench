import { isExpired } from './src/auth.js'

const MINUTE = 60 * 1000
const ok = isExpired(0, 31 * MINUTE) === true && isExpired(0, 29 * MINUTE) === false

console.log(ok ? 'auth: 1 passed' : 'auth: 1 failed')
process.exit(ok ? 0 : 1)
