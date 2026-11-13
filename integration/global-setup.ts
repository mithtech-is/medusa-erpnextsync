import { Client } from "pg"

/** The Product module runner expects its database to exist already. */
export default async function setup() {
    const client = new Client({
        host: process.env.DB_HOST ?? "127.0.0.1",
        user: process.env.DB_USERNAME ?? "postgres",
        password: process.env.DB_PASSWORD || undefined,
        database: "postgres",
    })
    await client.connect()
    const name = "medusa-product-integration-1"
    const found = await client.query("select 1 from pg_database where datname = $1", [name])
    if (!found.rowCount) await client.query(`create database "${name}"`)
    await client.end()
}
