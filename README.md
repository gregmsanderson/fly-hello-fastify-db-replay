# fly-hello-fastify-db-replay

A sample Fastify application that shows how the [Fly.io](https://fly.io) `fly-replay` header can be used to improve database performance.

## Motivation

Fly runs a global application platform. Your code can be deployed to virtual machines positioned close to your users to reduce latency. However most useful applications will need to interact with a database. If your application uses a database in a single region, that will introduce additional latency for users that are far away.

Fly's solution is a [multi-region database](https://fly.io/docs/getting-started/multi-region-databases/). Your primary database remains in one region however you can add multiple read replicas around the world. However that alone is not sufficient: fetching data is now fast but _storing_ data remains slow. The primary database is still far away. This can be mitigated by using Fly's ability to replay a request in another region. We'll use that ability to replay database writes in the primary database's region.

## Changes you need to make

#### fly.toml

If your Fastify application has already been packaged to run on Fly, you will have a `fly.toml` file (if not, Fly can generate one for you as part of the initial `fly launch` command).

For our `fly-replay` approach to work, the app needs to know where your primary database is. So add a `PRIMARY_REGION` environment variable to record its [region](https://fly.io/docs/reference/regions/#discovering-your-application-s-region). For example if your primary database is (or will be) in Chile you would add this:

```toml
[env]
PRIMARY_REGION = "scl"
```

#### server.js (or equivalent containing an error handler)

Fastify lets you specify a `setErrorHandler` function to handle errors: [https://www.fastify.io/docs/v3.8.x/Server/#seterrorhandler](https://www.fastify.io/docs/v3.8.x/Server/#seterrorhandler). Within that function you need to add some logic since we _know_ an error will happen (when we try to write data to a read replica). We need to handle that error. For example:

```js
if (typeof error.stack === 'string' && error.stack.includes('SqlState(\"25006\")')) {
    if (process.env.FLY_REGION && process.env.PRIMARY_REGION && process.env.FLY_REGION !== process.env.PRIMARY_REGION) {
      reply.header('fly-replay', 'region='  + process.env.PRIMARY_REGION)
      return reply.status(409).send("Replaying request in " + process.env.PRIMARY_REGION)
    }
  }
```

A complete `setErrorHandler` function _could_ look like this. Your error handler will likely have additional code. But you can see our addition:

```js
app.setErrorHandler(async (error, request, reply) => {
    if (typeof error.stack === 'string' && error.stack.includes('SqlState(\"25006\")')) {
        if (process.env.FLY_REGION && process.env.PRIMARY_REGION && process.env.FLY_REGION !== process.env.PRIMARY_REGION) {
            //app.log.debug("Replaying request in " + process.env.PRIMARY_REGION)
            reply.header('fly-replay', 'region='  + process.env.PRIMARY_REGION)
            return reply.status(409).send("Replaying request in " + process.env.PRIMARY_REGION)
        }
    }

    // other error
    app.log.error(error)

    reply.status(500).send({ error: "Something went wrong" });
});
```

**What does that do?**

First we check the error stack is available to parse. If so, we look for a particular error code thrown by PostgreSQL when we try to write to a read replica: it will have an error code of _25006_. At this point we know what's happened. We need to handle it. To see if we can handle it, we check three things: do we know the region the app is running in, do we now the region the primary database is in, and finally is that a different region? If so, we need to _replay_ this write (which is hitting a read replica) in the region the primary database is in. As we know _there_ it _will_ work. We replay the request by appending a `fly-replay` header and its value contains the region to replay it in.

#### (optional) PrismaClient

This part will vary depending on how your app interacts with the database.

Our sample app uses the popular [Prisma](https://www.prisma.io/) ORM, using the [Prisma-client only](https://www.prisma.io/docs/concepts/overview/what-is-prisma/data-modeling#using-only-prisma-client) approach. That needs to know the datasource to interact with. The Prisma client can set a value for its database URL at run-time. So that needs to use the same logic as the `setErrorHandler` above: if we know the region the app is running in **and** we know the region the primary database is in **and** the app is not running in that region then we should be interacting with the read replica. We do that by changing the port from `5432` to `5433`. Else we use the default value provided by Fly (which is the primary database, using port `5432`):

```js
const { PrismaClient } = Prisma
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.FLY_REGION && process.env.PRIMARY_REGION && process.env.FLY_REGION !== process.env.PRIMARY_REGION ? process.env.DATABASE_URL.replace(':5432/', ':5433/') : process.env.DATABASE_URL,
    },
  },
})
```

#### (optional) Fly-region header

To help with debugging you might like to add a `fly-region` header to each HTTP response to see the region that was returned from. We did that with a hook on `onSend`:

```js
app.addHook('onSend', async (request, reply, payload) => {
    reply.header('fly-region', process.env.FLY_REGION || '');
})
```

As with the custom error handler, your code _may_ use another name (likely `fastify.addHook`).

### Multi-region database

If you _already_ have a multi-region database, skip this section.

If not, the commands below show how to make a primary database with a single read replica. The primary is in Chile (`scl`) with a read replica in the UK (`lhr`). Choose regions appropriate for you. Based on the guide to [create a multi-region PostgreSQL database](https://fly.io/docs/getting-started/multi-region-databases/) we'll run:

```
# create a primary database in Chile
fly pg create --name postgres-database-app-here --region scl

# create a read replica in UK
fly volumes create pg_data --app postgres-database-app-here --size 1 --region lhr
fly scale count 2 --app postgres-database-app-here

# check its status
fly status --app postgres-database-app-here
```

It may take a moment for all of the read replica(s) to show as running.

Then (if you haven't already) make sure this app's `fly.toml` file's `[env]` section has the correct `PRIMARY_REGION` (the region _your_ primary database is in). For example ours is in Chile (`scl`):

```toml
[env]
PRIMARY_REGION = "scl"
```

## Deploy the app

If you already have a Fastify application then the above changes should be enough to make this technique work. Next time you deploy, your app should use the appropriate read replica or primary database. Writes to a nearby read replica will fail (as expected) and so be replayed in the region your primary database is in (so there needs to be at least one vm in that region to receive the request).

But if you are trying to deploy our sample app from this repo to Fly, please continue:

**Note:** In theory you could deploy this sample app _without_ having a database. _But_ the ORM we are using (Prisma) requires a `DATABASE_URL` to be set. It needs to be a non-empty string. Without that environment variable, it will return an error and so the deployment would fail. To solve that you _could_ add a placeholder, like this:

```toml
[env]
DATABASE_URL = "placeholder"
```

... and then the app _should_ deploy. But since we _will_ create a database first, we don't need to do that.

Edit the app's name in `fly.toml` to one of your choice:

```toml
app = "your-name-goes-here"
```

Now run `fly launch`.

This talks you through the steps. It will see the `fly.toml` so yes, use that:

```
An existing fly.toml file was found for app the-app-name
? Would you like to copy its configuration to the new app? Yes
```

It will proceed to create the app and see the `Dockerfile`:

```
Creating app in /path/to/app
Scanning source code
Detected a Dockerfile app
```

You will then be asked to give your app a name:

```
? App Name (leave blank to use an auto-generated name): your-name-goes-here
```

Choose an organization and then a region. For our test we'll pick `lhr`:

```
? Select region: lhr (London, United Kingdom)
```

When it asks if you would like to set up a database, say **N** (no). We have one which we'll attach _after_:

```
? Would you like to setup a Postgresql database now? N
```

It will ask if you want to deploy. Say **N** (no):

```
? Would you like to deploy now? (y/N) N
Your app is ready. Deploy with `flyctl deploy`
```

Why _not_ deploy right now? The sample app is using the [Prisma-client only](https://www.prisma.io/docs/concepts/overview/what-is-prisma/data-modeling#using-only-prisma-client) approach. As mentioned above, Prisma needs a `DATABASE_URL` environment variable to be set (as a non-empty string). Else it will error and the deploy will fail. So now that the app is staged, we need to attach the database to it:

`fly pg attach --postgres-app postgres-database-app-here`

Having done that the sample app _does_ now have a `DATABASE_URL` secret environment variable set. The Fly CLI will show you it (make a temporary note of that in order to use it below).

We _could_ deploy _now_. It should work. _But_ Prisma would complain that the `items` table it expects does not exist in the current database. So let's fix that first _before_ we deploy:

## Database schema

Our sample app does **not** use [Prisma's Migrate](https://www.prisma.io/docs/concepts/overview/what-is-prisma/data-modeling#using-prisma-client-and-prisma-migrate) to avoid additional complexity. As such it expects an _items_ table to already exist in the database. So now connect to your database using the credentials Fly showed you when attaching it to the app (the database name will be the same as the app's name).

Create the `items` table in it:

```sql
-- Table Definition
CREATE TABLE "public"."items" (
    "id" serial NOT NULL,
    "name" varchar(255) NOT NULL,
    "created_at" timestamp,
    "updated_at" timestamp,
    PRIMARY KEY ("id")
);
```

If you _are_ using Prisma's Migrate, you would normally run your database migration on deploy as a release command (within the `fly.toml` file's `[deploy]` section). Or you could manually run a migration on the vm using `fly ssh console`.

Finally **now** you can go ahead and deploy the staged sample app. Run:

`fly deploy`

It will take a minute. You should eventually see:

```
...
==> Creating release
...
==> Monitoring deployment
 1 desired, 1 placed, 1 healthy, 0 unhealthy [health checks: 2 total, 2 passing]
--> v0 deployed successfully
```

You can now run `fly open` or directly visit `https://your-app-name.fly.dev` and see the hello world JSON.

But its `/read` and `/write` routes still won't return the correct values. Why? The app currently only has one vm and we need two in order to replay failed writes.

## Make the sample app run in multiple regions

We'll run `fly regions set lhr scl` to set our app's regions as the UK and Chile (where our primary database is).

We'll remove any backup regions using `fly regions backup set`.

Now we can check the regions are the ones expected by using `fly regions list`.

Hsving done that we'll then scale our sample app by running `fly scale count 2`. We then have _two_ vms. One should be nearby (in `lhr`, where we are) and one far away (in `scl`, where our primary database is) in order to test the latency.

You can see its status using `fly status`. You should soon see _two_ vms (in the chosen regions). It may take a minute for the new one to show as running so please wait until it does:

```
Instances
ID              PROCESS VERSION REGION  DESIRED STATUS  HEALTH CHECKS           RESTARTS        CREATED
abcdefgh        app     2       lhr     run     running 2 total, 2 passing      0               2s ago
abcdefg1        app     2       scl     run     running 2 total, 2 passing      0               22s ago
```

## Try a database read and write

Our example application has a `/read` and `/write` route to test their performance. Normally writes would likely not be done during a GET request but using one makes it simpler to try using a normal web browser.

Now the sample app has vms running in multiple regions, you should be able to see their latency. Our app returns some JSON to show the read/write worked and the regions used.

**Note:** The duration/time (in ms) shown within the returned JSON is the in-app processing time (as you can see from the app's code in `server.js`). It is _not_ the complete http request/response time.

For example:

##### /read

```json
{
  "duration": 3.89,
  "data": [
    {
      "id": 35,
      "name": "TvFX0lEyo1"
    },
    {
      "id": 34,
      "name": "CMb2wkXEKe"
    },
    {
      "id": 33,
      "name": "6Wh12dG1gb"
    },
    {
      "id": 32,
      "name": "5pLOuQnLBR"
    },
    {
      "id": 31,
      "name": "x1pMwwA_97"
    }
  ],
  "regions": {
    "fly": "lhr",
    "primary": "scl"
  }
}
```

##### /write

```json
{
  "duration": 7.91,
  "data": {
    "id": 37,
    "name": "EvT6GnLDJK",
    "created_at": "2022-04-14T16:18:37.192Z",
    "updated_at": "2022-04-14T16:18:37.193Z"
  },
  "regions": {
    "fly": "scl",
    "primary": "scl"
  }
}
```

## Questions

### Why not use an onError hook?

Fastify's docs say that approach should not be used if your hook modifies the error.

### It doesn't seem to work

The first thing to check is the region your request is being served from. To put aside replaying for a moment, we know the sample app's `/read` route doesn't need to do any replaying of requests so _that_ should be returned from the _closest_ vm. You can see if it is by either looking at its headers (we added a `fly-region` header) or by looking at the returned JSON:

```json
{
    "regions": {
        "fly": "lhr",
        "primary": "scl"
    }
}
```

If the database read still _seems_ slow, it is possible you have been connected by Fly's proxy to the postgres leader, _not_ the nearby read replica. That's documented within Fly:

> 5433 is the port the keeper tells postgres to listen on. Connecting there goes straight to Postgres, though it might be the leader or the replica

You can confirm that by trying a `/write`. If the regions in the JSON differ but the app _could_ perform a write without replaying the request, well you _know_ that the database-write _must_ have gone to the leader. Because if it had done to a nearby read replica, it would have failed. As read replicas _can't_ be written to. And hence that's why it was slower.

Finally, it may help with debugging to add more details to the logs. Our sample app sets the log level based on an environment variable. You can set that in your `fly.toml`:

```toml
LOG_LEVEL = "debug"
```

Deploy the app, and once complete run `fly logs`. You should see lots of lines appear. Mainly these are from Fly's healthchecks (you can adjust their frequency in the `fly.toml` too). You may have seen in our sample app references to `app.log.debug()`. You can add more of your own. We added a log of the read/write latency, and also when the error handler triggers. You should see those lines appear in your logs as you make requests to see what's happening.

Any database writes that _aren't_ requested from the primary region should trigger an error, which is caught in our custom handler. You should see debug log lines to prove that, for example:

```
2022-04-14T16:18:37Z app[abcdefg] lhr [info]{"level":20,"time":1649953117083,"pid":515,"hostname":"abcdefg","msg":"Replaying request in scl"}
```

### The deployment fails

What error message do you see? You may need to run `fly logs` to see the latest messages.

> Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.

Make sure you are running `npx prisma generate` as part of the deployment. That generates the Prisma client. Since you would want that as part of every vm/image, you would normally do that as part of the `Dockerfile`. That's why our sample app's `Dockerfile` includes that command.

> Error: Unable to require(`/path/node_modules/prisma/libquery_engine-debian-openssl-1.1.x.so.node`)

Make sure your vm/image includes `openssl`. Our sample app uses a base image of `node:16.13-slim` so we added `openssl` by adding this line to it:

`RUN apt-get -qy update && apt-get -qy install openssl`

> throw new PrismaClientConstructorValidationError(Invalid value JSON.stringify(value1) for datasource "${key}" provided to PrismaClient constructor.

Check a `DATABASE_URL` has been defined. Ideally by attaching a real database to the app (so Fly handles setting that) or, if you can't, by using a temporary placeholder string within the `fly.toml` file's `[env]` section as mentioned above.

> Error validating datasource `db`: You must provide a nonempty URL. The environment variable `DATABASE_URL` resolved to an empty string

Are you using a placeholder? If you need to, that `DATABASE_URL` can't be an empty string. For example this will **not** work as a placeholder:

```toml
DATABASE_URL = ""
```

> Error validating datasource `db`: the URL must start with the protocol postgresql:// or postgres://

Does your app's `fly.toml` still have a placeholder value set within its `[env]` section? You will need to remove that line once you have attached a real multi-region database to the app. As Fly then sets the real `DATABASE_URL` at runtime. So remove the placeholder value line and run `fly deploy`.

## Run it locally

Running this app locally won't work as intended since writes to the database _won't_ be replayed.

If you do want to try it, you will need `node` (we use `nodemon` too to restart the server upon any change).

1. Clone this repo
2. Duplicate `.env.example` naming it `.env`
3. Run `npm install` to install its dependencies
4. Run `npm start` to run a local development server

You should be able to visit `http://localhost:3000` and at least see the hello world JSON.

If you are running the app locally on a Mac, you could even [make a local postgres database with a read replica](https://zzdjk6.medium.com/step-by-step-make-a-streaming-replica-of-postgresql-on-mac-e081eb565e8a). However, again, the `fly-replay` header won't work locally.
