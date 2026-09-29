/**
 * 极小 JSON Schema 校验器 + 关键字白名单检查。
 *
 * 存在的理由：DSH 工具注册表**只**接受一个受限的 JSON Schema 子集
 * （`CONSTRAINT_KEYWORDS` = type/oneOf/properties/required/additionalProperties/
 * items/enum/const，外加注解 description/title/default/examples）。写了
 * `minimum`/`maximum`/`pattern` 这类看着很像回事的关键字，注册时会被直接拒掉，
 * 而这类错误在运行时才暴露、且信息不直观。
 *
 * 所以在测试里把两件事都钉死：
 *   1. 四个工具的输出 schema 只用到白名单里的关键字；
 *   2. `execute()` 的返回值真的满足自己声明的 schema。
 */

/** 宿主注册表允许的约束关键字。与 dsh-tools 的 CONSTRAINT_KEYWORDS 对齐。 */
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/** 宿主注册表允许的注解关键字。 */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

/** 判断值属于哪个 JSON 类型名。整数另外认作 integer 也认作 number。 */
function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * 类型匹配。`integer` 只接受整数；`number` 整数与小数都收。
 *
 * @param {unknown} value 待判定值。
 * @param {string} type schema 声明的类型。
 * @returns {boolean} 是否匹配。
 */
function matchesType(value, type) {
  const actual = jsonType(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  return actual === type
}

/**
 * 按 schema 校验一个值。
 *
 * @param {unknown} value 待校验的值。
 * @param {object} schema schema 节点。
 * @param {string} [path] 出错时用于定位的路径。
 * @returns {string[]} 违规描述，空数组表示通过。
 */
export function validateSchema(value, schema, path = '$') {
  const problems = []
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    problems.push(`${path}: 期望 ${schema.type}，实际 ${jsonType(value)}`)
    // 类型都不对，后面的结构检查没有意义
    return problems
  }
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${path}: 期望常量 ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)} 中`)
  }
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter((branch) => validateSchema(value, branch, path).length === 0)
    if (matching.length !== 1) problems.push(`${path}: oneOf 命中了 ${matching.length} 个分支，应为 1 个`)
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${path}.${key}: 缺少必填字段`)
    }
    for (const [key, item] of Object.entries(value)) {
      const field = schema.properties?.[key]
      if (field === undefined) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key}: 多出了 schema 未声明的字段`)
        continue
      }
      problems.push(...validateSchema(item, field, `${path}.${key}`))
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      problems.push(...validateSchema(item, schema.items, `${path}[${index}]`))
    })
  }
  return problems
}

/**
 * 收集 schema 里用到的全部关键字，检查是否都在白名单内。
 *
 * `properties` 的键是字段名而不是关键字，所以只递归其值。
 *
 * @param {object} schema schema 节点。
 * @param {string} [path] 出错时用于定位的路径。
 * @returns {string[]} 非法关键字描述，空数组表示全部合法。
 */
export function unsupportedKeywords(schema, path = '$') {
  const problems = []
  for (const [key, value] of Object.entries(schema)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      problems.push(`${path}: 不支持的关键字 ${key}`)
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const [field, child] of Object.entries(value)) {
        problems.push(...unsupportedKeywords(child, `${path}.properties.${field}`))
      }
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      problems.push(...unsupportedKeywords(value, `${path}.items`))
    } else if (key === 'oneOf' && Array.isArray(value)) {
      value.forEach((branch, index) => {
        problems.push(...unsupportedKeywords(branch, `${path}.oneOf[${index}]`))
      })
    }
  }
  return problems
}
