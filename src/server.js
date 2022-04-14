import Fastify from 'fastify'
import dotenv from 'dotenv'
import Prisma from '@prisma/client'
import { nanoid } from "nanoid"

dotenv.config();

const { PrismaClient } = Prisma
const prisma = new PrismaClient({
  datasources: {
    db: {
      // *if* know the region running in AND know the region the primary database is in AND not running in that region, try and use the (closer) read replica
      // (and then catch/handle exceptions whenever do a write to that). Else don't
      url: (process.env.FLY_REGION && process.env.PRIMARY_REGION && process.env.FLY_REGION !== process.env.PRIMARY_REGION) ? process.env.DATABASE_URL.replace(':5432/', ':5433/') : process.env.DATABASE_URL
    },
  },
})

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
})

app.addHook('onSend', async (request, reply, payload) => {
    reply.header('fly-region', process.env.FLY_REGION || '');
})

app.setErrorHandler(async (error, request, reply) => {
  // tried to write to a read replica? That will throw an error:
  // "... code: SqlState(\"25006\"), message: \"cannot execute INSERT in a read-only transaction\" ...". If know
  // it, replay the request in the region the primary database is in:
  if (typeof error.stack === 'string' && error.stack.includes('SqlState(\"25006\")')) {
    if (process.env.FLY_REGION && process.env.PRIMARY_REGION && process.env.FLY_REGION !== process.env.PRIMARY_REGION) {
      app.log.debug("Replaying request in " + process.env.PRIMARY_REGION)
      reply.header('fly-replay', 'region='  + process.env.PRIMARY_REGION)
      return reply.status(409).send("Replaying request in " + process.env.PRIMARY_REGION)
    }
  }

  // other error
  app.log.error(error)

  reply.status(500).send({ error: "Something went wrong" });
});

app.get('/', async (request, reply) => {
    return { hello: 'world' }
})

app.get('/read', async (request, reply) => {
  const startTime = reply.getResponseTime()

  const data = await prisma.items.findMany({
    select: {
      id: true,
      name: true
    },
    orderBy: [
      {
        created_at: 'desc',
      }
    ],
    take: 5
  })

  const endTime = reply.getResponseTime()
  const duration = parseFloat((endTime - startTime).toFixed(2));
  app.log.debug('Read took: ' + duration + 'ms')

  reply.send({
    duration: duration,
    data: data,
    regions: {
      fly: process.env.FLY_REGION,
      primary: process.env.PRIMARY_REGION
    }
  })
})

app.get('/write', async (request, reply) => {
  const startTime = reply.getResponseTime()

  const data = await prisma.items.create({
    data: {
      name: nanoid(10)
    }
  })

  const endTime = reply.getResponseTime()
  const duration = parseFloat((endTime - startTime).toFixed(2));
  app.log.debug('Write took: ' + duration + 'ms')

  reply.send({
    duration: duration,
    data: data,
    regions: {
      fly: process.env.FLY_REGION,
      primary: process.env.PRIMARY_REGION
    }
  })
})

const start = async () => {
  try {
    await app.listen(process.env.PORT || 3000, '::')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()