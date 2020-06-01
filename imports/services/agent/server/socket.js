import socket_io from 'socket.io'

import { Meteor } from 'meteor/meteor'
import { WebApp } from 'meteor/webapp';
import { ExecutionsLogs } from '/imports/modules/executionslogs/both/collection'
import { Services } from '/imports/modules/services/both/collection'

import { executeNextStep, executionError } from '/imports/queue/server'
import { pick } from '/imports/helpers/both/objects'

// Server
const io = socket_io(WebApp.httpServer)

const logUpdate = (context, messages, results, extras) => {
  const { log, execution } = context

  if (results && !Array.isArray(results)) {
    results = [results]
  }

  let push = {
    msgs: { $each: messages }
  }

  if (results && results.length) {
    push['stepResult.data'] = { $each: results }
  }

  return ExecutionsLogs.update({_id: log, execution}, {
    $set: Object.assign({}, extras, { 'stepResult.type': 'array' }),
    $push: push
  })
}

let cachedSockets = {}

Meteor.startup(async () => {
  await Services.update(
    { type: 'agent' },
    {
      $set: { 'details.online': false },
      $unset: { 'secrets.socketId': '' }
    },
    { multi: true }
  )
  
  // middleware
  io.use(async (socket, next) => {
    let token = socket.handshake.query.token
    let c = await Services.findOne({
      type: 'agent',
      'config.token': token
    })

    if(!c) return next(new Error('authentication error'))

    socket.tf = {
      _id: c._id,
      token,
      user: c.user,
      title: c.title,
      description: c.description
    }
    return next()
  })

  // New client
  io.on('connection', async socket => {
    let auth = socket.tf
    await Services.update(
      { _id: auth._id },
      { 
        $set: {
          'details.online': true,
          'secrets.socketId': socket.id
        },
        $unset: { 'details.lastSeen': '' }
      }
    )
    
    cachedSockets[auth._id] = socket
    
    socket.emit('tf.authz', auth)

    // An agent is reporting std/err output.
    // Add this to the list of messages for the workflow's execution step.
    socket.on('tf.notify.progress', async message => {
      let date = message.date || new Date()
      let err = !!(message.stderr && message.stderr.length)
      let msgs = err ? message.stderr : message.stdout
      await logUpdate(
        message,
        msgs.map(msg => { return { m: msg, p: null, err, d: date } }),
        msgs
      )
    cachedSockets[auth._id] = socket
    })

    // An agent is reporting std/err output.
    // Add this to the list of messages for the workflow's execution step.
    socket.on('tf.notify.finishBulk', async message => {
      let err = !!message.code

      await logUpdate(
        message,
        message.stdLines.map(line => { return { 
          m: line.output,
          p: null,
          err: line.err,
          d: line.date
        } }),
        message.stdLines.map(l => {
          return `${l.err ? 'ERR ' : ''}${l.output}`
        }),
        { status: err ? 'error' : 'success' }
      )

      if (err) {
        executionError(pick(message, ['flow', 'execution']))
      }
      else {
        executeNextStep(pick(message, ['flow', 'execution', 'log', 'step']))
      }
    })

    // An agent is reporting std/err and the exit code
    // Add this to the list of messages for the workflow's execution step.
    socket.on('tf.notify.finish', async message => {
      let msgs = message.stdout || message.stderr
      let err = !!(message.stderr && message.stderr.length)

      await logUpdate(
        message,
        msgs.map(msg => { return { m: msg, p: null, err, d: new Date() } }),
        msgs,
        { status: err ? 'error' : 'success' }
      )

      if (err) {
        executionError(pick(message, ['flow', 'execution']))
      }
      else {
        executeNextStep(pick(message, ['flow', 'execution', 'log', 'step']))
      }
      // Once reported, check if the Workflow have more steps to execute
    })

    // An agent is reporting an exception when executing the command
    socket.on('tf.notify.exception', async message => {
      console.error('tf.notify.exception', message)
      await logUpdate(
        message,
        [
          { m: message.ex, p: null, err: true, d: new Date() }
        ],
        [ `ERR ${message.ex}` ],
        { status: 'error' }
      )
      executionError(pick(message, ['flow', 'execution']))
    })
    
    socket.on('disconnect', async socket => {
      await Services.update(
        { _id: auth._id },
        {
          $set: {
            'details.online': false,
            'details.lastSeen': new Date()
          },
          $unset: { 'secrets.socketId': '' }
        }
      )

      delete cachedSockets[auth._id]
    })
  })
})

/**
 * Sends a message to an agent.
 * 
 * @param {Object} agent 
 * @param {*} message 
 * @param {*} topic 
 * @param {Function} callback optional ack function
 */
const ioTo = (agent, message, topic, callback) => {
  if (agent === 'any') {
    // TODO Select the most recent-online agent and send it the message.
    // If not agents found, set the execution and the step as failed.
  }
  else {
    try {
      if (!agent.secrets.socketId) throw new Error('agent-not-connected')
      return io
        .to(agent.secrets.socketId)
        .emit(topic, message, callback)
    }
    catch (ex) {
      console.error(ex)
      if (message.execution) {
        executionError(pick(message, ['flow', 'execution']))
        return null
      }
      throw ex
    }
  }
}

module.exports.ioTo = ioTo

const ioToPrivate = (socket, topic, message, callback) => {
  return socket.emit(topic, message, callback)
}

module.exports.ioToPrivate = ioToPrivate

const fileExplorer = async (agent, options) => {
  return new Promise((resolve, reject) => {
    try {
      if (!cachedSockets[agent._id]) throw new Error('agent-not-available')
      ioToPrivate(cachedSockets[agent._id], 'tf.browser', options, data => {
        resolve(data)
      })
    }
    catch (ex) {
      reject(ex)
    }
  })
}

module.exports.fileExplorer = fileExplorer