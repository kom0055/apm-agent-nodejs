'use strict'

var agent = require('../../..').start({
  serviceName: 'test',
  secretToken: 'test',
  captureExceptions: false,
  metricsInterval: 0,
  centralConfig: false
})

var Server = require('mongodb-core').Server
var semver = require('semver')
var test = require('tape')
var version = require('mongodb-core/package').version

var mockClient = require('../../_mock_http_client')

test('instrument simple command', function (t) {
  const expected = semver.lt(version, '2.0.0')
    ? (process.platform === 'darwin' ? 11 : 10)
    : 7

  resetAgent(expected, function (data) {
    var trans = data.transactions[0]
    var groups

    t.equal(data.transactions.length, 1)

    t.equal(trans.name, 'foo')
    t.equal(trans.type, 'bar')
    t.equal(trans.result, 'success')

    // Ensure spans are sorted by start time
    data.spans = data.spans.sort((a, b) => {
      return a.timestamp - b.timestamp
    })

    if (semver.lt(version, '2.0.0')) {
      groups = [
        'system.$cmd.ismaster',
        'elasticapm.test.insert',
        'elasticapm.$cmd.command',
        'elasticapm.test.update',
        'elasticapm.$cmd.command',
        'elasticapm.test.remove',
        'elasticapm.$cmd.command',
        'elasticapm.test.find',
        'system.$cmd.ismaster'
      ]

      if (process.platform === 'darwin') {
        // mongodb-core v1.x will sometimes perform two `ismaster` queries
        // towards the admin and/or the system database. This doesn't always
        // happen, but if it does, we'll accept it.
        if (data.spans[0].name === 'admin.$cmd.ismaster') {
          groups.unshift('admin.$cmd.ismaster')
        } else if (data.spans[1].name === 'system.$cmd.ismaster') {
          groups.unshift('system.$cmd.ismaster')
        }
      }
    } else {
      groups = [
        'system.$cmd.ismaster',
        'elasticapm.test.insert',
        'elasticapm.test.update',
        'elasticapm.test.remove',
        'elasticapm.test.find',
        'system.$cmd.ismaster'
      ]
    }

    t.equal(data.spans.length, groups.length)

    // spans are sorted by their end time - we need them sorted by their start time
    data.spans = data.spans.sort(function (a, b) {
      return a.timestamp - b.timestamp
    })

    groups.forEach(function (name, i) {
      const span = data.spans[i]
      t.equal(span.name, name)
      t.equal(span.type, 'db')
      t.equal(span.subtype, 'mongodb')
      t.equal(span.action, 'query')

      var offset = span.timestamp - trans.timestamp
      t.ok(offset + span.duration * 1000 < trans.duration * 1000)
    })

    t.end()
  })

  var server = new Server({ host: process.env.MONGODB_HOST })

  agent.startTransaction('foo', 'bar')

  // test example lifted from https://github.com/christkv/mongodb-core/blob/2.0/README.md#connecting-to-mongodb
  server.on('connect', function (_server) {
    _server.command('system.$cmd', { ismaster: true }, function (err, results) {
      t.error(err)
      t.equal(results.result.ismaster, true)

      _server.insert('elasticapm.test', [{ a: 1 }, { a: 2 }, { a: 3 }], { writeConcern: { w: 1 }, ordered: true }, function (err, results) {
        t.error(err)
        t.equal(results.result.n, 3)

        _server.update('elasticapm.test', [{ q: { a: 1 }, u: { $set: { b: 1 } } }], { writeConcern: { w: 1 }, ordered: true }, function (err, results) {
          t.error(err)
          t.equal(results.result.n, 1)

          _server.remove('elasticapm.test', [{ q: { a: 1 }, limit: 1 }], { writeConcern: { w: 1 }, ordered: true }, function (err, results) {
            t.error(err)
            t.equal(results.result.n, 1)

            var cursor = _server.cursor('elasticapm.test', { find: 'elasticapm.test', query: {} })

            cursor.next(function (err, doc) {
              t.error(err)
              t.equal(doc.a, 2)

              cursor.next(function (err, doc) {
                t.error(err)
                t.equal(doc.a, 3)

                _server.command('system.$cmd', { ismaster: true }, function (err, result) {
                  t.error(err)
                  agent.endTransaction()

                  // Cleanup
                  _server.remove('elasticapm.test', [{ q: {}, limit: 0 }], { writeConcern: { w: 1 }, ordered: true }, function (err, results) {
                    t.error(err)
                    _server.destroy()
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  server.connect()
})

function resetAgent (expected, cb) {
  agent._instrumentation.currentTransaction = null
  agent._transport = mockClient(expected, cb)
  agent.captureError = function (err) { throw err }
}
