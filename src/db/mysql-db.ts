import chalk from 'chalk';
import * as mysql2 from 'mysql2/promise';

import * as dbConfig from '../../database.json';
import { logger } from '../log';
import { sql } from '../sql-string';

import { SQLDatabase, SQLStatement } from './db';
import { setupPreparedStatements } from './prepared';

class MySQLStatement implements SQLStatement {
  protected name: string;
  protected text: string;
  protected values: any[];
  protected conn: mysql2.Connection;
  protected statement: Promise<any>;
  public constructor(
    name: string,
    text: string,
    values: any[],
    conn: mysql2.Connection
  ) {
    this.name = name;
    this.text = text;
    this.values = values;
    this.conn = conn;
    this.statement = (conn as any).prepare(text);
  }
  public async get<T>(...params: any[]): Promise<T> {
    let statement = await this.statement;
    let res = await statement.execute(params);
    return res.rows[0];
  }
  public async all<T>(...params: any[]): Promise<T[]> {
    let statement = await this.statement;
    let res = await statement.execute(params);
    return res.rows;
  }
}

// tslint:disable-next-line:only-arrow-functions
const pool: mysql2.Pool = (function () {
  const {
    mysql: { database, host, port, schema, user, password }
  } = dbConfig as any;
  let p: mysql2.Pool = mysql2.createPool({
    connectionLimit: 10,
    host,
    user,
    password,
    database,
    port
  });

  if (process.env.NODE_ENV !== 'test') {
    logger.info(
      chalk.yellow(
        process.env.DATABASE_URL
          ? `Creating database pool for ${process.env.DATABASE_URL}`
          : `Creating database pool for mysql://${user}@${host}:${port}#${database}`
      )
    );
  }
  return p;
})();

(pool as any).on('error', (err: Error) => {
  logger.error('Unexpected error on idle client', err.message);
  process.exit(-1);
});

// tslint:disable-next-line:max-classes-per-file
export default class MySQLDB extends SQLDatabase<MySQLStatement> {
  public static async setup(): Promise<MySQLDB> {
    const client = await pool.getConnection();
    try {
      let mysqldb = new this(client);
      // let data = await mysqldb.get(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
      // console.log('DATA: ', data);
      mysqldb.statements = await setupPreparedStatements<
        MySQLStatement,
        MySQLDB
        >(mysqldb);
      // if (!this.pubSubSupport) {
      //   this.pubSubSupport = await setupPubSub(pool);
      // }
      return mysqldb;
    } catch (e) {
      logger.error(`ERROR during posgres setup\n${e}`);
      throw e;
    } finally {
      client.release();
    }
  }
  // private static pubSubSupport: pg.Client;
  private connection: mysql2.Connection;

  protected constructor(connection: mysql2.Connection) {
    super();
    this.connection = connection;
  }
  // tslint:disable-next-line:no-empty
  public async shutdown(): Promise<void> {
    // PostgresDB.pubSubSupport.release();
    await pool.end();
  }
  public async run(
    query: string,
    ...params: any[]
  ): Promise<{ lastID: number | string }> {
    if (
      query
        .toLowerCase()
        .trim()
        .indexOf('insert into ') >= 0
    ) {
      query = `${query} RETURNING id`;
    }
    return this.measure(this.normalizeQuery(query), params, async () => {
      let [res, _] = await this.connection.query(query, params);
      let lastID = null;
      if (res && (res as any[]).length > 0) {
        lastID = (res as any[])[0].id;
      }
      return { lastID };
    });
  }
  public async get<T>(query: string, ...params: any[]): Promise<T> {
    return this.measure(query, params, async () => {
      return await this.connection
        .query(this.normalizeQuery(query), params)
        .then(([result, _]) => (result as T[])[0]);
    });
  }
  public async all<T>(query: string, ...params: any[]): Promise<T[]> {
    return this.measure(this.normalizeQuery(query), params, async () => {
      return await this.connection.query(query, params).then(([result, _]) => result as T[]);
    });
  }
  public prepare(
    name: string,
    query: string,
    ...params: any[]
  ): Promise<MySQLStatement> {
    return Promise.resolve(
      new MySQLStatement(name, query, params, this.connection)
    );
  }
  public async getIndicesForTable(tableName: string): Promise<string[]> {
    return (await this.all(sql`select indexname as name
    from pg_indexes where tablename = \'${tableName}\'`)).map(
      (result: any) => result.name as string
      );
  }
  public async getAllTriggers(): Promise<string[]> {
    return (await this
      .all(sql`select tgname as name from pg_trigger,pg_proc where
    pg_proc.oid=pg_trigger.tgfoid AND tgisinternal = false`)).map(
      (result: any) => result.name as string
      );
  }
  public async getAllMaterializedViews(): Promise<string[]> {
    return (await this.all(
      sql`SELECT oid::regclass::text FROM pg_class WHERE  relkind = 'm'`
    )).map((result: any) => result.oid as string);
  }
  public async getAllViews(): Promise<string[]> {
    return (await this.all(
      sql`select viewname as name from pg_catalog.pg_views;`
    )).map((result: any) => result.name as string);
  }
  public async getAllFunctions(): Promise<string[]> {
    return (await this.all(sql`SELECT routines.routine_name as name
FROM information_schema.routines
    LEFT JOIN information_schema.parameters ON routines.specific_name=parameters.specific_name
WHERE routines.specific_schema='public'
ORDER BY routines.routine_name, parameters.ordinal_position;`)).map(
      (result: any) => result.name as string
      );
  }
  public async getAllTableNames(): Promise<string[]> {
    return (await this.all(sql`SELECT table_name as name
      FROM information_schema.tables
     WHERE table_schema='public'
       AND table_type='BASE TABLE';`)).map(
      (result: any) => result.name as string
      );
  }

  private normalizeQuery(str: string): string {
    return str.replace(/\$\s*[0-9]+/g, '?');
  }
}
