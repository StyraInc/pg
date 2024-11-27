import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { Results, PGlite } from "@electric-sql/pglite";
import { postgresTransformer } from "@/utils/postgres";
import { createJSONStorage, persist } from "zustand/middleware";
import { Cell, DataGridValue } from "@/components/ui/data-viewer";
import { generateMermaidErd, getDatabaseSchema } from "@/postgres/setup";
import {
  SampleDataMeta,
  SampleDatakey,
  getSampleDatabaseQuery,
} from "@/postgres/sample-data";
import {
  removeIDBItem,
  postgreIDBName,
  zustandIDBStorage,
  postgreIDBConnection,
} from "@/utils/idb";

interface Connection {
  name: string;
  postgres: PGlite;
}

export interface QueryResult {
  affectedRows: number;
  totalRecords?: number;
}

export interface QueryHistory {
  error?: string;
  statement: string;
  statementWithFilter?: string;
  createdAt?: string;
  executionTime?: number; // ms
  results?: QueryResult[];
}

export type TableType = "BASE TABLE" | "VIEW";

export type TableColumn = {
  type: string;
  column: string;
  nullable: boolean;
  length: string | null;
};

export interface DatabaseSchema {
  schema: string;
  tables: {
    table: string;
    type: TableType;
    columns: TableColumn[];
  }[];
}

export interface Database {
  name: string;

  createdAt?: string;

  description?: string;

  history: QueryHistory[];

  schema: DatabaseSchema[];

  /**
   * we are using mermaid js syntax
   * to generating erd
   */
  erd: string;

  query?: string;

  rego?: string;

  input?: Record<string, unknown>;

  data?: Record<string, unknown>;

  evaluated?: string;

  filter?: string;

  datagrid?: DataGridValue<Cell>[];
}

interface State {
  active: Connection | undefined;

  databases: Record<string, Database>;

  create: (data: Pick<Database, "name" | "description">) => Promise<void>;

  update: (name: string, data: Pick<Database, "description">) => Promise<void>;

  import: (data: SampleDataMeta<SampleDatakey>) => Promise<void>;

  remove: (name: string) => Promise<void>;

  connect: (name: string) => Promise<void>;

  execute: (
    query: string,
    rego?: string,
    filter?: boolean,
  ) => Promise<Results[] | undefined>;

  evaluate: (rego: string) => Promise<Record<string, any> | undefined>;

  reload: () => Promise<void>;
}

// NOTE(sr):
// 1. "package conditions" and "query" is a must
// 2. we need the rego.v1 import because the Preview API has no "v1" flag
const defaultRego = "";
const rego = {
  orders: `package conditions
import rego.v1

filter["users.name"] := input.user
filter["products.price"] := {"lte": 500} if input.budget == "low"

expanded := ucast.expand(filter)
query := ucast.as_sql(expanded, "postgres", {"users": {"$self": "u"}, "products": {"$self": "p"}})
`,
  schools: `package conditions
import rego.v1

filter["students.name"] := input.user

expanded := ucast.expand(filter)
query := ucast.as_sql(expanded, "postgres", {"students": {"$self": "s1"}})
`,
};

const inputs = {
  orders: { user: "Emma Clark", budget: "low" },
  schools: { user: "Emma Johnson" },
};
const defaultInput = {};

const defaultSql = "SELECT * FROM information_schema.tables";
const sql = {
  orders: `select u.name as user, p.name as product, p.price
from orders o
inner join users u on o.user_id = u.id
inner join order_items i on o.order_id = i.order_id
inner join products p on i.product_id = p.product_id
`,
  schools: `SELECT DISTINCT s2.*
FROM student_subjects ss1
NATURAL JOIN students s1
JOIN student_subjects ss2 ON ss1.subject_id = ss2.subject_id
JOIN students s2 ON ss2.student_id = s2.student_id
`,
};

export const useDBStore = create<State>()(
  persist(
    immer((set, get) => ({
      active: undefined,

      databases: {},

      create: async (data) => {
        if (get().databases[data.name])
          throw new Error(`db with name: ${data.name} already exists`);

        const postgres = new PGlite(postgreIDBConnection(data.name));

        const schema = await getDatabaseSchema(postgres);

        const erd = await generateMermaidErd(postgres);

        return set((state) => {
          state.active = {
            name: data.name,
            postgres: postgres,
          };

          state.databases[data.name] = {
            name: data.name,
            description: data.description,
            createdAt: new Date().toLocaleString(),
            query: "SELECT * FROM information_schema.tables",
            rego: defaultRego,
            input: defaultInput,
            history: [],
            erd: erd,
            schema: schema,
          };
        });
      },

      update: async (name, data) =>
        set((state) => {
          state.databases[name].description = data.description;

          state.databases[name].createdAt = new Date().toLocaleString();
        }),

      import: async (data) => {
        const sqlCreateQuery = await getSampleDatabaseQuery(data.key);

        /**
         * name with random 5 digit string
         */
        const name = `${data.key}-${Math.floor(Math.random() * 90000) + 10000}`;

        const postgres = new PGlite(postgreIDBConnection(name));

        /**
         * import data
         */
        await postgres.exec(sqlCreateQuery);

        const schema = await getDatabaseSchema(postgres);

        const erd = await generateMermaidErd(postgres);

        /**
         * prepare panes
         */

        const tbl = data.key;
        const r = rego[tbl] || defaultRego;
        const s = sql[tbl] || defaultSql;
        const i = inputs[tbl] || defaultInput;

        set((state) => {
          state.active = {
            name: name,
            postgres: postgres,
          };

          state.databases[name] = {
            name: name,
            description: data.description,
            createdAt: new Date().toLocaleString(),
            query: s,
            rego: r,
            input: i,
            history: [],
            erd: erd,
            schema: schema,
          };
        });
      },

      remove: async (name) => {
        set((state) => {
          state.active = undefined;

          delete state.databases[name];
        });

        removeIDBItem(postgreIDBName(name));
      },

      connect: async (name) => {
        const postgres = new PGlite(postgreIDBConnection(name));

        const schema = await getDatabaseSchema(postgres);

        const erd = await generateMermaidErd(postgres);

        return set((state) => {
          state.active = {
            name: name,
            postgres: postgres,
          };

          state.databases[name].erd = erd;
          state.databases[name].schema = schema;
        });
      },

      evaluate: async (rego) => {
        const connection = get().active!;
        const { input, data } = get().databases[connection.name];

        // EOPA Preview API
        const req = {
          input,
          data,
          rego_modules: {
            "main.rego": rego,
          },
        };
        const resp = await fetch("/v0/preview/conditions", {
          method: "POST",
          body: JSON.stringify(req),
        });
        if (!resp.ok) {
          throw new Error(`EOPA: ${resp.statusText}`);
        }
        const result = await resp.json();

        if ("code" in result) {
          throw new Error(result?.message);
        }

        set((state) => {
          state.databases[connection.name].rego = rego;
          state.databases[connection.name].evaluated = result?.result;
          state.databases[connection.name].filter = result?.result?.query;
        });
        return result;
      },

      execute: async (query, rego, filter) => {
        const connection = get().active!;

        const startTime = performance.now();
        const createdAt = new Date().toLocaleString();

        const evalFilter = rego && (await get().evaluate(rego))?.result?.query;

        try {
          if (!query || !query.trim()) throw new Error(`no query to run`);
          const query0 = filter ? combine(query, evalFilter) : query;

          const result = await connection.postgres.exec(query0);

          set((state) => {
            state.databases[connection.name].query = query;

            state.databases[connection.name].datagrid =
              postgresTransformer(result);

            state.databases[connection.name].history.push({
              statement: query,
              statementWithFilter: query0,
              createdAt: createdAt,
              executionTime: performance.now() - startTime,
              results: result.map((r) => ({
                affectedRows: r.affectedRows || 0,
                totalRecords: r.rows.length || 0,
              })),
            });
          });

          return result;
        } catch (error) {
          set((state) => {
            state.databases[connection.name].query = query;

            state.databases[connection.name].datagrid = [];

            state.databases[connection.name].history.push({
              statement: query,
              createdAt: createdAt,
              error: (error as Error).message,
              executionTime: performance.now() - startTime,
            });
          });

          throw error;
        }
      },

      reload: async () => {
        const connection = get().active!;

        const schema = await getDatabaseSchema(connection.postgres);

        const erd = await generateMermaidErd(connection.postgres);

        set((state) => {
          state.databases[connection.name].erd = erd;
          state.databases[connection.name].schema = schema;
        });
      },
    })),
    {
      name: "zustand-store",
      storage: createJSONStorage(() => zustandIDBStorage),
      partialize: (state) => ({ databases: state.databases }),
    },
  ),
);

function combine(existing: string, filter: string | undefined): string {
  if (!filter) return existing;

  existing = existing.trimEnd();
  if (existing.endsWith(";")) existing = existing.slice(0, -1);

  const sansWhere = filter.slice(6);
  if (/where/i.test(existing)) {
    return existing + "\nAND " + sansWhere;
  }
  return existing + "\nWHERE " + sansWhere;
}
