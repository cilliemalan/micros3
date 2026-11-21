import { describe, expect, it } from "vitest"
import {
  buildCorsXml,
  emptyRuleForm,
  escapeXml,
  formToRule,
  lines,
  parseCorsXml,
  ruleProblems,
  ruleToForm,
  unescapeXml,
  type CorsRule,
} from "./cors"

const full: CorsRule = {
  id: "dev <app> & co",
  allowedOrigins: ["http://localhost:5173", "https://*.example.com"],
  allowedMethods: ["GET", "PUT"],
  allowedHeaders: ["*"],
  exposeHeaders: ["ETag", "x-amz-meta-owner"],
  maxAgeSeconds: 3000,
}

// The shape cors::serialize writes: namespace, headers before methods.
const serverXml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><ID>a &amp; b</ID><AllowedHeader>*</AllowedHeader><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedOrigin>*</AllowedOrigin><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>60</MaxAgeSeconds></CORSRule><CORSRule><AllowedMethod>PUT</AllowedMethod><AllowedOrigin>http://a.test</AllowedOrigin></CORSRule></CORSConfiguration>`

describe("XML escaping", () => {
  it("round-trips the five entities", () => {
    const text = `<a href="x">'&'</a>`
    expect(escapeXml(text)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;")
    expect(unescapeXml(escapeXml(text))).toBe(text)
  })
  it("reads numeric character references", () => {
    expect(unescapeXml("&#65;&#x263A;&amp;lt;")).toBe("A☺&lt;")
  })
})

describe("buildCorsXml and parseCorsXml", () => {
  it("round-trips a full rule and a minimal rule", () => {
    const minimal: CorsRule = {
      allowedOrigins: ["*"],
      allowedMethods: ["HEAD"],
      allowedHeaders: [],
      exposeHeaders: [],
    }
    const xml = buildCorsXml([full, minimal])
    expect(xml).toContain('<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">')
    expect(xml).toContain("<ID>dev &lt;app&gt; &amp; co</ID>")
    expect(xml).not.toContain("<MaxAgeSeconds>undefined")
    expect(parseCorsXml(xml)).toEqual([full, minimal])
  })

  it("reads the server's serialization", () => {
    expect(parseCorsXml(serverXml)).toEqual([
      {
        id: "a & b",
        allowedOrigins: ["*"],
        allowedMethods: ["GET", "HEAD"],
        allowedHeaders: ["*"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 60,
      },
      { allowedOrigins: ["http://a.test"], allowedMethods: ["PUT"], allowedHeaders: [], exposeHeaders: [] },
    ])
  })

  it("reads namespace prefixes and skips unknown elements", () => {
    const xml = `<s3:CORSConfiguration xmlns:s3="x"><s3:CORSRule><s3:AllowedOrigin> * </s3:AllowedOrigin><s3:Other/><s3:AllowedMethod>GET</s3:AllowedMethod></s3:CORSRule></s3:CORSConfiguration>`
    expect(parseCorsXml(xml)).toEqual([
      { allowedOrigins: ["*"], allowedMethods: ["GET"], allowedHeaders: [], exposeHeaders: [] },
    ])
  })

  it("gives no rules for a document without any", () => {
    expect(parseCorsXml("<CORSConfiguration/>")).toEqual([])
  })
})

describe("the rule form", () => {
  it("splits lines and drops blanks", () => {
    expect(lines(" a \r\n\n b\n  \n")).toEqual(["a", "b"])
  })

  it("converts a rule to the form and back", () => {
    expect(formToRule(ruleToForm(full))).toEqual(full)
  })

  it("orders methods as S3 lists them and leaves out an empty ID and max age", () => {
    const rule = formToRule({ ...emptyRuleForm(), origins: "*", methods: ["DELETE", "GET"], id: "  " })
    expect(rule).toEqual({
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "DELETE"],
      allowedHeaders: [],
      exposeHeaders: [],
    })
  })

  it("accepts a valid form", () => {
    expect(ruleProblems({ ...emptyRuleForm(), origins: "http://localhost:*", maxAge: "0" })).toEqual({})
  })

  it("needs an origin and a method", () => {
    const problems = ruleProblems({ ...emptyRuleForm(), origins: " \n", methods: [] })
    expect(problems.origins).toBeTruthy()
    expect(problems.methods).toBeTruthy()
  })

  it("refuses two wildcards in an origin or allowed header", () => {
    const problems = ruleProblems({ ...emptyRuleForm(), origins: "http://*.*.test", allowedHeaders: "x-*-*" })
    expect(problems.origins).toContain("http://*.*.test")
    expect(problems.allowedHeaders).toContain("x-*-*")
  })

  it("refuses a max age that is not a whole number", () => {
    for (const maxAge of ["-1", "1.5", "ten", "1e3", "99999999999999999999"]) {
      expect(ruleProblems({ ...emptyRuleForm(), origins: "*", maxAge }).maxAge, maxAge).toBeTruthy()
    }
  })

  it("refuses an ID longer than 255 characters", () => {
    expect(ruleProblems({ ...emptyRuleForm(), origins: "*", id: "x".repeat(256) }).id).toBeTruthy()
    expect(ruleProblems({ ...emptyRuleForm(), origins: "*", id: "x".repeat(255) }).id).toBeUndefined()
  })
})
