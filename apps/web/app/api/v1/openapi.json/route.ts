import { NextResponse } from 'next/server';
import { APP_STAGE, APP_VERSION } from '../../../../lib/version.ts';

export const dynamic = 'force-static';

// Reusable component pieces. Keeping them as JS objects (instead of inlined
// in every endpoint) lets the schema stay consistent and tooling (Redoc,
// codegen) generate decent client SDKs from $ref'd entities.
const components = {
  securitySchemes: {
    Bearer: {
      type: 'http',
      scheme: 'bearer',
      description:
        'API キー (Stripe スタイル)。`Authorization: Bearer <key>` で送信。レガシー互換で `X-API-Key` ヘッダおよび HTTP Basic (key as username) も受け付けます。キー発行は /account/keys (Google サインイン)。レート制限: 600 req/min, 100,000 req/day。',
    },
  },

  parameters: {
    PrefCode: {
      in: 'query',
      name: 'pref',
      description: 'JIS 都道府県コード (01〜47)',
      required: false,
      schema: { type: 'string', pattern: '^[0-9]{2}$', example: '14' },
    },
    WatershedSlug: {
      in: 'query',
      name: 'watershed',
      description: '水系の slug (例: `淀川`, `相模川`)',
      required: false,
      schema: { type: 'string', example: '相模川' },
    },
    ManagerName: {
      in: 'query',
      name: 'manager',
      description: '管理者名の完全一致 (例: `国土交通省`, `神奈川県企業庁`)',
      required: false,
      schema: { type: 'string', example: '国土交通省' },
    },
    Cursor: {
      in: 'query',
      name: 'cursor',
      description: 'ページング用カーソル。前のレスポンスの `_links.next` から取得。',
      required: false,
      schema: { type: 'string', example: '8852' },
    },
    PageSize: {
      in: 'query',
      name: 'pageSize',
      description: '1 ページあたりの件数 (1〜200, 既定 50)',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    DamSlug: {
      in: 'path',
      name: 'slug',
      required: true,
      description: 'ダムの slug (例: `doushi-14`)',
      schema: { type: 'string', example: 'doushi-14' },
    },
    WatershedSlugPath: {
      in: 'path',
      name: 'slug',
      required: true,
      description: '水系の slug',
      schema: { type: 'string', example: '相模川' },
    },
    PrefCodePath: {
      in: 'path',
      name: 'code',
      required: true,
      description: 'JIS 都道府県コード (01〜47)',
      schema: { type: 'string', pattern: '^[0-9]{2}$', example: '14' },
    },
    From: {
      in: 'query',
      name: 'from',
      required: true,
      description: '時系列の開始時刻 (ISO 8601, UTC 推奨)',
      schema: { type: 'string', format: 'date-time', example: '2026-04-01T00:00:00Z' },
    },
    To: {
      in: 'query',
      name: 'to',
      required: true,
      description: '時系列の終了時刻 (ISO 8601, 排他)',
      schema: { type: 'string', format: 'date-time', example: '2026-05-01T00:00:00Z' },
    },
    Interval: {
      in: 'query',
      name: 'interval',
      required: true,
      description:
        '集計バケット。`hourly` は生観測 (1 時間粒度)、`daily`/`monthly` は TimescaleDB の continuous aggregate を読みます。',
      schema: { type: 'string', enum: ['hourly', 'daily', 'monthly'], example: 'daily' },
    },
    Format: {
      in: 'query',
      name: 'format',
      required: false,
      description:
        '`json` (HAL+JSON, 既定) または `csv`。CSV は `Content-Disposition: attachment` で返却。',
      schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
    },
    ExcludeSynthetic: {
      in: 'query',
      name: 'exclude_synthetic',
      required: false,
      description:
        '`1` / `true` を指定すると、シード値 (`source_id = "synthetic"`) を除外し、複数の実測ソース (例: `tokyo-waterworks` + `jwa-junpo`) を同時に返します。`hourly` バケット時のみ有効。',
      schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
    },
    ObservationCursor: {
      in: 'query',
      name: 'cursor',
      description:
        'ページング用カーソル。前のレスポンスの `_links.next` (または `Link: rel="next"` ヘッダ) から取得します。`(observed_at, dam_id, source_id)` を base64url で符号化した不透明値で、クライアントが組み立てるものではありません。',
      required: false,
      schema: { type: 'string', example: 'MjA5OS0wMi0wMVQwMDowMDowMC4wMDBafDg4NTJ8a2FzZW5ib3NhaQ' },
    },
    ObservationPageSize: {
      in: 'query',
      name: 'pageSize',
      description: '1 ページあたりの件数 (1〜1000, 既定 100)',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    },
    RealDataOnly: {
      in: 'query',
      name: 'real',
      required: false,
      description:
        '`1` / `true` を指定すると、直近 30 日に非 synthetic 観測値があるダムのみを返します。',
      schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
    },
    SourceFilter: {
      in: 'query',
      name: 'source',
      required: false,
      description:
        '指定の `source_id` (例: `tokyo-waterworks`, `jwa-junpo`) で直近 30 日に観測値があるダムのみを返します。',
      schema: { type: 'string', pattern: '^[a-zA-Z0-9_:-]+$', maxLength: 64 },
    },
    Lat: {
      in: 'query',
      name: 'lat',
      required: true,
      description: '緯度 (WGS 84, EPSG:4326)',
      schema: { type: 'number', minimum: 24, maximum: 46, example: 35.55056 },
    },
    Lng: {
      in: 'query',
      name: 'lng',
      required: true,
      description: '経度 (WGS 84, EPSG:4326)',
      schema: { type: 'number', minimum: 122, maximum: 146, example: 139.13361 },
    },
  },

  schemas: {
    HalLink: {
      type: 'object',
      description:
        'HAL+JSON のリンクオブジェクト。`href` は同一オリジンの相対 URL またはサイト URL。',
      required: ['href'],
      properties: {
        href: { type: 'string', example: '/api/v1/dams/doushi-14' },
        title: { type: 'string', nullable: true },
        type: { type: 'string', nullable: true, example: 'application/hal+json' },
      },
    },
    HalLinks: {
      type: 'object',
      description: 'リソースの代表的なリンク群。`self` は必ず存在。',
      required: ['self'],
      additionalProperties: { $ref: '#/components/schemas/HalLink' },
      properties: {
        self: { $ref: '#/components/schemas/HalLink' },
        next: { $ref: '#/components/schemas/HalLink' },
        prev: { $ref: '#/components/schemas/HalLink' },
        dam: { $ref: '#/components/schemas/HalLink' },
        watershed: { $ref: '#/components/schemas/HalLink' },
        prefecture: { $ref: '#/components/schemas/HalLink' },
      },
    },

    Problem: {
      type: 'object',
      description: 'RFC 7807 problem+json エラーレスポンス。',
      required: ['status', 'title'],
      properties: {
        type: { type: 'string', default: 'about:blank' },
        title: { type: 'string', example: 'Invalid query' },
        status: { type: 'integer', example: 400 },
        detail: { type: 'string', nullable: true },
        instance: { type: 'string', nullable: true, format: 'uri' },
      },
      example: { type: 'about:blank', title: 'Invalid query', status: 400 },
    },

    PrefectureCode: {
      type: 'string',
      pattern: '^(0[1-9]|[1-3][0-9]|4[0-7])$',
      description: 'JIS 都道府県コード (01=北海道 〜 47=沖縄)',
    },

    Watershed: {
      type: 'object',
      required: ['id', 'slug', 'code', 'name', 'kind'],
      properties: {
        id: { type: 'string', description: 'BIGINT を 10 進文字列化', example: '123' },
        slug: { type: 'string', example: '相模川' },
        code: {
          type: 'string',
          description:
            '内部の一意キー。国土数値情報 W01（ダム）の水系名から生成した `W01-<水系名>` 形式で、国土数値情報の水系域コードではありません（水系域コードは `ndiCode`）。',
          example: 'W01-相模川',
        },
        name: { type: 'string', example: '相模川' },
        nameKana: {
          type: 'string',
          nullable: true,
          description: '現状は未投入（常に null）。',
          example: null,
        },
        kind: {
          type: 'string',
          enum: ['first', 'second', 'other'],
          description:
            '河川法上の区分。first = 一級水系（水系域コードが地方整備局番号 81–89 で始まる 109 水系）、second = 二級水系（国土数値情報 W05 の区間種別に二級河川区間を含む）、other = 準用・普通河川のみの水系、または水系名がコードリストと一致しなかったもの。',
          example: 'first',
        },
        ndiCode: {
          type: 'string',
          nullable: true,
          description:
            '国土数値情報の水系域コード（河川コード上位 6 桁。W07_002 / W05_001 と同じ体系）。水系名がコードリストと一致しなかった場合は null。',
          example: '830307',
        },
        areaKm2: {
          type: 'number',
          nullable: true,
          description: '現状は未投入（常に null）。',
          example: null,
        },
        damCount: { type: 'integer', nullable: true, example: 8 },
      },
    },

    DamListItem: {
      type: 'object',
      required: ['id', 'slug', 'name', 'prefCode', 'location'],
      properties: {
        id: { type: 'string', example: '7163' },
        slug: { type: 'string', example: 'doushi-14' },
        name: { type: 'string', example: '道志' },
        prefCode: { $ref: '#/components/schemas/PrefectureCode' },
        manager: { type: 'string', nullable: true, example: '神奈川県企業庁' },
        totalCapacityM3: {
          type: 'string',
          nullable: true,
          description: '総貯水容量 (m³, NUMERIC を文字列化)',
          example: '1525000.00',
        },
        activeCapacityM3: {
          type: 'string',
          nullable: true,
          description: '利水容量 (m³, NUMERIC を文字列化)。諸元の静的値。',
          example: '616000.00',
        },
        location: {
          type: 'object',
          required: ['lat', 'lng'],
          properties: {
            lat: { type: 'number', example: 35.55056 },
            lng: { type: 'number', example: 139.13361 },
          },
        },
        watershed: {
          type: 'object',
          nullable: true,
          description:
            '所属水系。`slug` で `/api/v1/watersheds/{slug}` を辿れます。未割当なら null。',
          required: ['slug', 'name'],
          properties: {
            slug: { type: 'string', example: '相模川' },
            name: { type: 'string', example: '相模川' },
          },
        },
      },
    },

    DamDetail: {
      allOf: [
        { $ref: '#/components/schemas/DamListItem' },
        {
          type: 'object',
          properties: {
            nameKana: { type: 'string', nullable: true, example: 'どうし' },
            type: {
              type: 'string',
              nullable: true,
              description:
                '型式 (例: `重力式コンクリート`, `アーチ式コンクリート`, `アースフィル`, `ロックフィル` 等)',
              example: '重力式コンクリート',
            },
            heightM: { type: 'string', nullable: true, example: '32.80' },
            effectiveCapacityM3: {
              type: 'string',
              nullable: true,
              description: '有効貯水容量 (= 総貯水容量 − 堆砂容量)。Damnet 由来。',
              example: '616000.00',
            },
            activeCapacityM3: {
              type: 'string',
              nullable: true,
              description:
                '利水容量。貯水率 (storage_rate) の分母として採用。Damnet 由来 (約 87% のダムで populated)。',
              example: '616000.00',
            },
            floodCapacityM3: { type: 'string', nullable: true },
            constructionStartYear: { type: 'integer', nullable: true, example: 1952 },
            completedYear: { type: 'integer', nullable: true, example: 1955 },
            purposes: {
              type: 'string',
              nullable: true,
              description:
                '目的コード列。F=洪水調節 / N=不特定 / A=灌漑 / W=上水 / I=工業 / P=発電 / S=消流雪',
              example: 'P',
            },
            crestLengthM: { type: 'string', nullable: true, example: '74.00' },
            embankmentVolumeM3: { type: 'string', nullable: true, example: '24000.00' },
            watershedAreaKm2: { type: 'string', nullable: true, example: '112.500' },
            reservoirAreaKm2: { type: 'string', nullable: true, example: '0.1400' },
            leftBankLocation: {
              type: 'string',
              nullable: true,
              example: '神奈川県相模原市緑区牧野',
            },
            mainContractor: { type: 'string', nullable: true, example: '西松建設' },
            redevelopmentStatus: { type: 'string', nullable: true },
            elevationM: { type: 'number', nullable: true, example: 311 },
            externalIds: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'ソース別の外部 ID。',
              example: { ndi: '716', damnet: '0699' },
            },
            latest: {
              type: 'object',
              nullable: true,
              description: '最新観測値。観測値が 1 件もなければ null。',
              properties: {
                observedAt: { type: 'string', format: 'date-time' },
                sourceId: { type: 'string', example: 'kasenbosai' },
                storageVolumeM3: { type: 'string', nullable: true, example: '1992000.00' },
                storageRate: {
                  type: 'string',
                  nullable: true,
                  description:
                    '貯水率 (0..1、100% 超もあり得る)。`trusted_rate_basis` なソースでは出典が公表する利水容量貯水率をそのまま格納し、それ以外は貯水量 ÷ 諸元の利水容量。',
                  example: '0.9230',
                },
                inflowM3s: { type: 'string', nullable: true },
                outflowM3s: { type: 'string', nullable: true },
                waterLevelM: { type: 'string', nullable: true },
                rainfallMm: { type: 'string', nullable: true },
                qualityFlag: { type: 'integer', example: 0 },
                effectiveActiveCapacityM3: {
                  type: 'string',
                  nullable: true,
                  description:
                    '表示している貯水率の分母 (m³)。信頼ソースの利水容量貯水率から逆算 (貯水量 ÷ 貯水率) した季節反映値で、洪水期は諸元の `activeCapacityM3` より大幅に小さくなり得ます (issue #19)。信頼ソースでなければ `activeCapacityM3` と同じ。注意: 出典側で貯水率が 100% に頭打ちされている場合は貯水量そのものになり、実際の利水容量を上回り得ます。',
                  example: '2158000.00',
                },
              },
            },
            dataRealness: {
              type: 'object',
              description:
                '実測データの有無。`hasRealDataLast30d` が true の場合、直近 30 日に `synthetic` 以外のソースからの観測値あり。',
              required: ['hasRealDataLast30d', 'realSourceId'],
              properties: {
                hasRealDataLast30d: { type: 'boolean', example: true },
                realSourceId: {
                  type: 'string',
                  nullable: true,
                  description:
                    '直近 30 日で最新の非 synthetic 観測値の source_id (`tokyo-waterworks`, `jwa-junpo`, 等)。',
                  example: 'tokyo-waterworks',
                },
              },
            },
          },
        },
      ],
    },

    Observation: {
      type: 'object',
      description:
        '観測値レコード。`hourly` 解像度では原始値を、`daily`/`monthly` では TimescaleDB の continuous aggregate (`obs_daily`, `obs_monthly`) を読み出します。集計バケットでは `inflow_m3s` / `outflow_m3s` は NULL になります。',
      required: ['observedAt', 'qualityFlag', 'sourceId'],
      properties: {
        observedAt: { type: 'string', format: 'date-time', example: '2026-05-01T07:00:00Z' },
        storageVolumeM3: { type: 'string', nullable: true, example: '590432.10' },
        storageRate: {
          type: 'string',
          nullable: true,
          description:
            '上流ソース由来の貯水率 (0..1)。dam の利水容量を分母にしないため、UI では `storageVolumeM3 / activeCapacityM3` を再計算しています。',
          example: '0.958',
        },
        inflowM3s: { type: 'string', nullable: true, example: '0.755' },
        outflowM3s: { type: 'string', nullable: true, example: '0.652' },
        waterLevelM: { type: 'string', nullable: true },
        rainfallMm: { type: 'string', nullable: true },
        qualityFlag: {
          type: 'integer',
          description: '0=正常, 1=推定, 2=観測停止, 3=異常値',
          enum: [0, 1, 2, 3],
          example: 0,
        },
        sourceId: {
          type: 'string',
          description: 'データの出処。`aggregate` は continuous aggregate 由来。',
          example: 'aggregate',
        },
      },
    },

    DamListResponse: {
      type: 'object',
      required: ['items', '_links'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/DamListItem' } },
        nextCursor: { type: 'string', nullable: true, example: '8852' },
        _links: { $ref: '#/components/schemas/HalLinks' },
      },
    },

    DamDetailResponse: {
      type: 'object',
      required: ['_links'],
      allOf: [
        { $ref: '#/components/schemas/DamDetail' },
        {
          type: 'object',
          properties: { _links: { $ref: '#/components/schemas/HalLinks' } },
        },
      ],
    },

    FeedObservation: {
      type: 'object',
      description:
        'ダム横断フィードの 1 行。`observations` ハイパーテーブルの生の行に、ダムの識別子とリンクを添えたもの。集計バケットは通りません。',
      required: ['damId', 'damSlug', 'observedAt', 'sourceId', 'qualityFlag'],
      allOf: [
        {
          type: 'object',
          properties: {
            damId: {
              type: 'string',
              description: 'ダムの内部 ID (bigint を文字列化)',
              example: '7163',
            },
            damSlug: { type: 'string', example: 'doushi-14' },
            damName: { type: 'string', example: '道志' },
          },
        },
        { $ref: '#/components/schemas/Observation' },
        {
          type: 'object',
          properties: {
            // Item-level links, so HalLinks (which requires `self`) doesn't fit:
            // the item is not itself an addressable resource, it points at its dam.
            _links: {
              type: 'object',
              required: ['dam'],
              additionalProperties: { $ref: '#/components/schemas/HalLink' },
              properties: {
                dam: { $ref: '#/components/schemas/HalLink' },
                observations: { $ref: '#/components/schemas/HalLink' },
              },
            },
          },
        },
      ],
    },

    ObservationFeedResponse: {
      type: 'object',
      required: ['items', 'count', '_links'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/FeedObservation' } },
        count: { type: 'integer', description: 'このページの件数', example: 100 },
        _links: { $ref: '#/components/schemas/HalLinks' },
      },
    },

    ObservationsResponse: {
      type: 'object',
      required: ['series', 'count', '_links'],
      properties: {
        series: { type: 'array', items: { $ref: '#/components/schemas/Observation' } },
        count: { type: 'integer', example: 720 },
        source: {
          type: 'string',
          nullable: true,
          description: '`hourly` 解像度のときは優先採用されたソース ID',
        },
        _links: { $ref: '#/components/schemas/HalLinks' },
      },
    },

    WatershedDetailResponse: {
      type: 'object',
      required: ['aggregate', '_links'],
      allOf: [
        { $ref: '#/components/schemas/Watershed' },
        {
          type: 'object',
          properties: {
            aggregate: {
              type: 'object',
              description:
                '水系全体の集計。`GET /api/v1/watersheds/{slug}/aggregate` と同じ内容をネストして返します。',
              properties: {
                damCount: { type: 'integer' },
                totalCapacityM3: { type: 'string', nullable: true },
                activeCapacityM3: { type: 'string', nullable: true },
                rateableDamCount: { type: 'integer' },
                latestStorageVolumeM3: { type: 'string', nullable: true },
                observedAt: { type: 'string', format: 'date-time', nullable: true },
              },
            },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
      ],
    },

    WatershedListResponse: {
      type: 'object',
      required: ['items', '_links'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/Watershed' } },
        nextCursor: { type: 'string', nullable: true },
        _links: { $ref: '#/components/schemas/HalLinks' },
      },
    },

    Health: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', example: true },
        version: { type: 'string', example: APP_VERSION },
        observations: {
          type: 'object',
          properties: {
            latest: { type: 'string', format: 'date-time', nullable: true },
            count: { type: 'integer' },
          },
        },
      },
    },
  },

  responses: {
    BadRequest: {
      description: 'リクエストパラメータが不正',
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
      },
    },
    Unauthorized: {
      description: 'API キーが欠落 / 無効',
      headers: {
        'WWW-Authenticate': {
          schema: { type: 'string', example: 'Bearer realm="dam.teraren.com"' },
        },
      },
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
      },
    },
    NotFound: {
      description: 'リソースが見つからない',
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
      },
    },
    RateLimited: {
      description: 'レート上限超過',
      headers: {
        'RateLimit-Limit': { schema: { type: 'integer', example: 600 } },
        'RateLimit-Remaining': { schema: { type: 'integer', example: 0 } },
        'RateLimit-Reset': {
          schema: { type: 'integer', description: 'リセットまでの秒数', example: 42 },
        },
        'Retry-After': { schema: { type: 'integer', example: 42 } },
      },
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
      },
    },
  },
};

const ERR_RESPONSES = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '404': { $ref: '#/components/responses/NotFound' },
  '429': { $ref: '#/components/responses/RateLimited' },
};

const paths = {
  '/api/v1/healthz': {
    get: {
      summary: 'ヘルスチェック',
      tags: ['system'],
      security: [],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Health' },
              example: {
                ok: true,
                version: APP_VERSION,
                observations: { latest: '2026-05-04T22:00:00Z', count: 6767865 },
              },
            },
          },
        },
      },
    },
  },

  '/api/v1/sources': {
    get: {
      summary: 'データソース一覧',
      tags: ['system'],
      security: [],
      description:
        '稼働中のデータ取込ソースとそれぞれの最終取得時刻を返します。`/sources` HTML ページの内訳と同じ。',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              example: {
                items: [
                  {
                    sourceId: 'ndi',
                    description: '国土数値情報 (master location/code)',
                    priority: 80,
                    active: true,
                    lastFetchedAt: '2026-04-01T03:00:00Z',
                  },
                  {
                    sourceId: 'damnet',
                    description: 'ダム便覧 (master attributes)',
                    priority: 50,
                    active: true,
                    lastFetchedAt: '2026-05-04T03:00:00Z',
                  },
                ],
                _links: { self: { href: '/api/v1/sources' } },
              },
            },
          },
        },
      },
    },
  },

  '/api/v1/dams': {
    get: {
      summary: 'ダム一覧',
      tags: ['dams'],
      description:
        '都道府県・水系・管理者で絞り込み可能なダム一覧。`cursor` で連続取得、ID 順に並びます。',
      parameters: [
        { $ref: '#/components/parameters/PrefCode' },
        { $ref: '#/components/parameters/WatershedSlug' },
        { $ref: '#/components/parameters/ManagerName' },
        { $ref: '#/components/parameters/Cursor' },
        { $ref: '#/components/parameters/PageSize' },
        { $ref: '#/components/parameters/RealDataOnly' },
        { $ref: '#/components/parameters/SourceFilter' },
      ],
      responses: {
        '200': {
          description: 'OK',
          headers: {
            Link: {
              description: 'RFC 5988 ページネーション (`rel="next"` / `"prev"`)',
              schema: { type: 'string' },
            },
          },
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/DamListResponse' },
              example: {
                items: [
                  {
                    id: '7163',
                    slug: 'doushi-14',
                    name: '道志',
                    prefCode: '14',
                    manager: '神奈川県企業庁',
                    totalCapacityM3: '1525000.00',
                    activeCapacityM3: '616000.00',
                    location: { lat: 35.55056, lng: 139.13361 },
                    watershed: { slug: '相模川', name: '相模川' },
                  },
                ],
                nextCursor: '7164',
                _links: {
                  self: { href: '/api/v1/dams?pref=14' },
                  next: { href: '/api/v1/dams?pref=14&cursor=7164' },
                },
              },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/dams/{slug}': {
    get: {
      summary: 'ダム詳細',
      tags: ['dams'],
      parameters: [{ $ref: '#/components/parameters/DamSlug' }],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/DamDetailResponse' },
              example: {
                id: '7163',
                slug: 'doushi-14',
                name: '道志',
                nameKana: 'どうし',
                prefCode: '14',
                manager: '神奈川県企業庁',
                type: '重力式コンクリート',
                heightM: '32.80',
                totalCapacityM3: '1525000.00',
                effectiveCapacityM3: '616000.00',
                activeCapacityM3: '616000.00',
                floodCapacityM3: null,
                constructionStartYear: 1952,
                completedYear: 1955,
                purposes: 'P',
                crestLengthM: '74.00',
                watershedAreaKm2: '112.500',
                reservoirAreaKm2: '0.1400',
                leftBankLocation: '神奈川県相模原市緑区牧野',
                mainContractor: '西松建設',
                lat: 35.55056,
                lng: 139.13361,
                elevationM: 311,
                externalIds: { ndi: '716', damnet: '0699' },
                _links: {
                  self: { href: '/api/v1/dams/doushi-14' },
                  observations: {
                    href: '/api/v1/dams/doushi-14/observations?from=&to=&interval=daily',
                  },
                  watershed: { href: '/api/v1/watersheds/相模川' },
                  prefecture: { href: '/api/v1/prefectures/14/dams' },
                },
              },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/observations': {
    get: {
      summary: 'ダム横断の計測値フィード',
      tags: ['observations'],
      description:
        '全ダムの生の観測値 (1 時間粒度) を `from`〜`to` のウィンドウで返します。ダムを指定せずに取り込みたい同期クライアント向け。`(observed_at, dam_id, source_id)` 昇順で、keyset カーソルによりページングします。返すのは実測値のみです (シード値 `source_id = "synthetic"` は常に除外)。単一ダムの時系列やグラフ用途、集計バケット (`daily` / `monthly`)、CSV が必要な場合は `/api/v1/dams/{slug}/observations` を使ってください。\n\n30 日より古いデータは TimescaleDB の圧縮チャンクに載るため、1 ページの取得コストは `pageSize` ではなく「カーソル位置から現在の 14 日チャンク末尾まで」の行数に比例します (それより後のチャンクは走査されません)。過去データを大量に取り込む場合は `pageSize` を大きく (1000) 取るほど総コストが下がります。',
      parameters: [
        { $ref: '#/components/parameters/From' },
        { $ref: '#/components/parameters/To' },
        { $ref: '#/components/parameters/ObservationCursor' },
        { $ref: '#/components/parameters/ObservationPageSize' },
      ],
      responses: {
        '200': {
          description: 'OK',
          headers: {
            Link: {
              description: 'RFC 5988 ページネーション (`rel="next"`)。最終ページでは付きません。',
              schema: { type: 'string' },
            },
          },
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/ObservationFeedResponse' },
              example: {
                items: [
                  {
                    damId: '7163',
                    damSlug: 'doushi-14',
                    damName: '道志',
                    observedAt: '2026-05-01T00:00:00.000Z',
                    sourceId: 'kasenbosai',
                    storageVolumeM3: '590432.10',
                    storageRate: '0.9580',
                    inflowM3s: '0.755',
                    outflowM3s: '0.652',
                    waterLevelM: null,
                    rainfallMm: null,
                    qualityFlag: 0,
                    _links: {
                      dam: { href: '/api/v1/dams/doushi-14' },
                      observations: {
                        href: '/api/v1/dams/doushi-14/observations{?from,to,interval}',
                        templated: true,
                      },
                    },
                  },
                ],
                count: 100,
                _links: {
                  self: {
                    href: '/api/v1/observations?from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z',
                  },
                  next: {
                    href: '/api/v1/observations?from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z&cursor=MjAyNi0wNS0wMVQwMDowMDowMC4wMDBafDcxNjN8a2FzZW5ib3NhaQ',
                  },
                },
              },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/dams/{slug}/observations': {
    get: {
      summary: 'ダムの貯水量履歴 (時系列)',
      tags: ['observations'],
      description:
        '指定ウィンドウのダム時系列を返します。`hourly` は生観測、`daily`/`monthly` は continuous aggregate。`format=csv` で CSV ダウンロード (`Content-Disposition: attachment`)。',
      parameters: [
        { $ref: '#/components/parameters/DamSlug' },
        { $ref: '#/components/parameters/From' },
        { $ref: '#/components/parameters/To' },
        { $ref: '#/components/parameters/Interval' },
        { $ref: '#/components/parameters/Format' },
        { $ref: '#/components/parameters/ExcludeSynthetic' },
      ],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/ObservationsResponse' },
              example: {
                series: [
                  {
                    observedAt: '2026-05-01T00:00:00Z',
                    storageVolumeM3: '590432.10',
                    storageRate: null,
                    inflowM3s: null,
                    outflowM3s: null,
                    qualityFlag: 0,
                    sourceId: 'aggregate',
                  },
                ],
                count: 30,
                source: null,
                _links: {
                  self: {
                    href: '/api/v1/dams/doushi-14/observations?from=2026-04-01T00:00:00Z&to=2026-05-01T00:00:00Z&interval=daily',
                  },
                  dam: { href: '/api/v1/dams/doushi-14' },
                  csv: {
                    href: '/api/v1/dams/doushi-14/observations?from=2026-04-01T00:00:00Z&to=2026-05-01T00:00:00Z&interval=daily&format=csv',
                  },
                },
              },
            },
            'text/csv': {
              schema: { type: 'string' },
              example:
                'dam_slug,observed_at,storage_volume_m3,storage_rate,inflow_m3s,outflow_m3s,quality_flag,source_id\n' +
                'doushi-14,2026-05-01T00:00:00.000Z,590432.10,,,,0,aggregate\n',
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/watersheds': {
    get: {
      summary: '水系一覧',
      tags: ['watersheds'],
      parameters: [
        {
          in: 'query',
          name: 'kind',
          description: "'first' (一級), 'second' (二級), 'other' (その他)",
          required: false,
          schema: { type: 'string', enum: ['first', 'second', 'other'] },
        },
        { $ref: '#/components/parameters/Cursor' },
        { $ref: '#/components/parameters/PageSize' },
      ],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/WatershedListResponse' },
              example: {
                items: [
                  {
                    id: '83',
                    slug: '相模川',
                    code: 'W01-相模川',
                    name: '相模川',
                    kind: 'first',
                    ndiCode: '830307',
                    damCount: 8,
                  },
                ],
                nextCursor: null,
                _links: { self: { href: '/api/v1/watersheds?kind=first' } },
              },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/watersheds/{slug}': {
    get: {
      summary: '水系詳細',
      tags: ['watersheds'],
      parameters: [{ $ref: '#/components/parameters/WatershedSlugPath' }],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/WatershedDetailResponse' },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/watersheds/{slug}/dams': {
    get: {
      summary: '水系内のダム一覧',
      tags: ['watersheds'],
      parameters: [
        { $ref: '#/components/parameters/WatershedSlugPath' },
        { $ref: '#/components/parameters/Cursor' },
        { $ref: '#/components/parameters/PageSize' },
      ],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/DamListResponse' },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/watersheds/{slug}/observations': {
    get: {
      summary: '水系合計の貯水量履歴 (ダム横断 SUM)',
      tags: ['observations'],
      description:
        '水系内のダムの `storage_volume_m3` をバケット時刻ごとに合算した時系列を返します。利水容量を持つダム subset でのみ集計するため、貯水率は信頼できます。',
      parameters: [
        { $ref: '#/components/parameters/WatershedSlugPath' },
        { $ref: '#/components/parameters/From' },
        { $ref: '#/components/parameters/To' },
        { $ref: '#/components/parameters/Interval' },
        { $ref: '#/components/parameters/Format' },
        { $ref: '#/components/parameters/ExcludeSynthetic' },
      ],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/ObservationsResponse' },
            },
            'text/csv': {
              schema: { type: 'string' },
              example:
                'watershed_slug,observed_at,storage_volume_m3,storage_rate,quality_flag,source_id\n' +
                '相模川,2026-05-01T00:00:00.000Z,4263821000.00,,0,aggregate\n',
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/watersheds/{slug}/aggregate': {
    get: {
      summary: '水系の集計指標 (現在値)',
      tags: ['watersheds'],
      parameters: [{ $ref: '#/components/parameters/WatershedSlugPath' }],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              example: {
                damCount: 8,
                totalCapacityM3: '6300000000.00',
                activeCapacityM3: '4800000000.00',
                rateableDamCount: 6,
                latestStorageVolumeM3: '4200000000.00',
                observedAt: '2026-05-04T22:00:00Z',
                _links: { self: { href: '/api/v1/watersheds/相模川/aggregate' } },
              },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/prefectures/{code}/dams': {
    get: {
      summary: '都道府県内のダム一覧',
      tags: ['dams'],
      parameters: [
        { $ref: '#/components/parameters/PrefCodePath' },
        { $ref: '#/components/parameters/Cursor' },
        { $ref: '#/components/parameters/PageSize' },
      ],
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/hal+json': {
              schema: { $ref: '#/components/schemas/DamListResponse' },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },

  '/api/v1/watershed': {
    get: {
      summary: '指定座標を含む水系を返す (PostGIS ST_Contains)',
      tags: ['geocode'],
      parameters: [
        { $ref: '#/components/parameters/Lat' },
        { $ref: '#/components/parameters/Lng' },
      ],
      responses: {
        '200': {
          description:
            'OK — 座標が水系に含まれる場合は対応する水系、そうでない場合は最寄りの水系を返します。',
          content: {
            'application/hal+json': {
              example: {
                slug: '相模川',
                code: 'W01-相模川',
                name: '相模川',
                kind: 'first',
                ndiCode: '830307',
                contains: true,
                _links: { self: { href: '/api/v1/watershed?lat=35.55056&lng=139.13361' } },
              },
            },
          },
        },
        ...ERR_RESPONSES,
      },
    },
  },
};

const tags = [
  { name: 'dams', description: 'ダムマスタおよび付随情報' },
  { name: 'watersheds', description: '水系 (一級・二級・その他) と集計' },
  { name: 'observations', description: '貯水量・流入量・放流量の時系列' },
  { name: 'geocode', description: '座標 → 水系の逆引き' },
  { name: 'system', description: 'ヘルスチェック・データソース情報' },
];

export async function GET() {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Dam Data Platform API',
      version: APP_VERSION,
      summary:
        '日本国内 2,749 基のダムマスタと貯水量履歴の公開 API。リアルタイム値は再配信していません。',
      description: [
        `> **${APP_STAGE.toUpperCase()} stage (v${APP_VERSION})** — 本サービスは現在アルファ段階です。データの正確性・可用性・互換性は今後変動する可能性があります。詳細は [/roadmap](/roadmap) を参照してください。`,
        '',
        '## 概要',
        '日本国内のダム諸元 (位置・容量・管理者ほか) と貯水量履歴 (1 時間粒度) を JSON / CSV で配信する公益 API です。',
        '',
        '## 認証',
        '認証付きエンドポイントは `Authorization: Bearer <key>` を要求します。キーは [/account/keys](/account/keys) で Google サインインから発行 (無料、600 req/min · 100,000 req/day)。',
        '',
        '## レスポンス形式',
        '- 通常成功: `application/hal+json` (HAL Level 3, `_links` で関連リソースを発見可能)',
        '- 観測値 CSV: `text/csv` (`format=csv`)',
        '- エラー: `application/problem+json` (RFC 7807)',
        '',
        '## ID とスラッグ',
        '- ダム slug: `<読み仮名>-<JIS pref code>` (例: `doushi-14`)',
        '- 水系 slug: 水系名そのまま (例: `相模川`)',
        '- 数値 ID は BIGINT のため文字列として返却します。',
        '',
        '## 出典・ライセンス',
        '原典は 国土数値情報・ダム便覧・国土地理院・ja.wikipedia (写真フォールバック)。再配布時は原典のライセンス条件 (CC-BY-SA 等) に従ってください。詳細は /sources。',
      ].join('\n'),
      contact: { name: 'Dam Data Japan', url: 'https://discord.gg/UbWqspWbAk' },
      license: { name: 'Terms of use', url: 'https://dam.teraren.com/legal/terms' },
    },
    servers: [
      {
        url: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
        description: 'デフォルトサーバ',
      },
    ],
    tags,
    components,
    security: [{ Bearer: [] }],
    paths,
  };
  return NextResponse.json(spec, { headers: { 'cache-control': 'public, max-age=300' } });
}
