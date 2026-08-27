# ⚡ bun-lambda

[![GitHub Action](https://img.shields.io/badge/GitHub%20Action-bun--lambda-FBF0DF?logo=githubactions&logoColor=black)](https://github.com/dev-swarup/bun-lambda)
[![Bun](https://img.shields.io/badge/Bun-1.2+-black?logo=bun&logoColor=white)](https://bun.sh)
[![AWS Lambda](https://img.shields.io/badge/AWS%20Lambda-provided.al2023-FF9900?logo=awslambda&logoColor=white)](https://aws.amazon.com/lambda/)
[![Architecture](https://img.shields.io/badge/Architecture-x86__64%20%7C%20arm64-blue)](https://aws.amazon.com/ec2/graviton/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`bun-lambda`** is an GitHub Action that compiles TypeScript and JavaScript applications into standalone, bytecode-optimized `bootstrap` binaries for AWS Lambda custom runtimes (`provided.al2023` / `provided.al2`).

By leveraging Bun's Ahead-of-Time (AOT) compiler with embedded JavaScriptCore (JSC) bytecode (`bun build --compile --bytecode`), `bun-lambda` completely eliminates runtime TypeScript parsing, module graph traversal, and interpreter warmup—delivering near-instantaneous Lambda cold starts.

---

## 📑 Table of Contents

- [The Cold-Start Problem & Solution](#-the-cold-start-problem--solution)
- [Architecture & Execution Lifecycle](#-architecture--execution-lifecycle)
- [Quick Start](#-quick-start)
- [Handler Paradigms](#-handler-paradigms)
  - [1. Event-Driven Handler (Standard Lambda)](#1-event-driven-handler-standard-lambda)
  - [2. Fetch Handler (Web Standards / HTTP APIs)](#2-fetch-handler-web-standards--http-apis)
- [Action Reference](#-action-reference)
  - [Inputs](#inputs)
  - [Outputs](#outputs)
- [AWS Lambda Configuration](#-aws-lambda-configuration)
  - [Terraform / OpenTofu](#terraform--opentofu)
  - [AWS CDK (TypeScript)](#aws-cdk-typescript)
  - [Serverless Framework](#serverless-framework)
  - [AWS SAM](#aws-sam)
- [Production Recipes](#-production-recipes)
  - [Full CI/CD with AWS OIDC Deployment](#full-cicd-with-aws-oidc-deployment)
  - [Bundling External Static Files & Prisma Engines](#bundling-external-static-files--prisma-engines)
  - [Enabling Inline Source Maps for Production Debugging](#enabling-inline-source-maps-for-production-debugging)
- [Performance & Operational Considerations](#-performance--operational-considerations)
- [License](#-license)

---

## 🏎️ The Cold-Start Problem & Solution

Traditional Node.js and interpreted Bun Lambda deployments spend significant CPU cycles during initialization (`INIT` phase):
1. Launching the interpreter/runtime process.
2. Walking the file system to resolve `node_modules`.
3. Reading and parsing dozens or hundreds of `.js` / `.ts` files into ASTs.
4. JIT-compiling hot code paths.

```
Traditional Custom Runtime:
Lambda Boot ──► Shell Script ──► Bun Process ──► Parse TS/JS ──► JIT Compile ──► Handler Execution
                [ ~15-30ms ]     [ ~40-80ms ]    [ ~100-300ms ]  [ ~50-100ms ]   (Total: 200-500ms+)

bun-lambda (Compiled Bytecode):
Lambda Boot ──► Native ELF Binary (Bytecode Embedded) ─────────────────────────► Handler Execution
                [ ~10-25ms on Graviton2/arm64 ]                                   (Total: <30ms cold start)
```

### Why `bun build --compile --bytecode`?
- **Zero Parsing Overhead**: Source code is compiled directly into JSC bytecode at build time in CI.
- **Single Native ELF Executable**: Bundles the JavaScriptCore runtime, your handler logic, and all upstream dependencies into a single binary named `bootstrap`.
- **Direct Runtime API Loop**: No shell wrappers (`bootstrap.sh`) or intermediate process spawns; Lambda invokes the ELF binary directly.

---

## 🏛️ Architecture & Execution Lifecycle

```
BUILD PHASE (GitHub Actions Runner)
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Checkout repository                                                 │
│ 2. Resolve handler entrypoint (e.g. index.handler -> index.ts)         │
│ 3. Inject typed Lambda Runtime API loop client                         │
│ 4. Run `bun build --compile --bytecode --minify --target=bun-linux-...`│
│ 5. Package standalone `bootstrap` + extra assets into `bootstrap.zip`  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Deploy via AWS CLI / CDK / Terraform
                                   ▼
RUNTIME PHASE (AWS Lambda Execution Environment: provided.al2023)
┌────────────────────────────────────────────────────────────────────────┐
│ AWS Lambda MicroVM Initializer (Firecracker)                           │
│  └─► Executes `/var/task/bootstrap` directly                           │
│        ├─► Initializes JSC VM with pre-compiled bytecode               │
│        ├─► Binds pre-compiled Handler method                           │
│        └─► Enters HTTP Long-Poll Loop against AWS_LAMBDA_RUNTIME_API   │
│              ├─► GET  /2018-06-01/runtime/invocation/next              │
│              ├─► Dispatch Event to Handler                             │
│              └─► POST /2018-06-01/runtime/invocation/{id}/response     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

Add the following step to your GitHub Actions workflow file (e.g. `.github/workflows/deploy.yml`):

```yaml
name: Build & Deploy Lambda

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Build Bun Lambda Package
        id: bun-lambda
        uses: dev-swarup/bun-lambda@v1
        with:
          arch: 'arm64'              # Recommended for best price-performance
          dir: '.'
          handler: 'src/index.handler'
          output: 'dist/bootstrap.zip'

      - name: Authenticate to AWS via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-lambda-deployer
          aws-region: us-east-1

      - name: Update Lambda Function Code
        run: |
          aws lambda update-function-code \
            --function-name my-production-service \
            --zip-file fileb://${{ steps.bun-lambda.outputs.path }}
```

---

## 🧩 Handler Paradigms

`bun-lambda` natively auto-detects your export pattern at compile time.

### 1. Event-Driven Handler (Standard Lambda)

Ideal for API Gateway proxy events, SQS, SNS, S3 events, DynamoDB Streams, and EventBridge.

```typescript
// src/index.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Processed via Bun Lambda AOT bytecode!",
      requestId: context.awsRequestId,
      remainingTimeMs: context.getRemainingTimeInMillis(),
      bunVersion: Bun.version,
    }),
  };
};
```

Default export functions are also supported:
```typescript
export default async function (event: any, context: any) {
  return { status: "ok" };
}
```

### 2. Fetch Handler (Web Standards / HTTP APIs)

Build lightweight HTTP handlers using standard Web API `Request` and `Response` objects (compatible with fetch-based routers like Hono).

```typescript
// src/index.ts
export default {
  async fetch(request: Request): Promise<Response> {
    const data = await request.json().catch(() => ({}));
    const requestId = request.headers.get("x-amzn-requestid");

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      requestId,
      echo: data,
    });
  },
};
```

Module-level `fetch` export is equally supported:
```typescript
export async function fetch(req: Request): Promise<Response> {
  return new Response("Hello from Bun!");
}
```

---

## 📖 Action Reference

### Inputs

| Input | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `bun-version` | `string` | `'latest'` | Target Bun compiler version (e.g. `'1.2.0'` or `'latest'`). |
| `arch` | `string` | `'x86_64'` | Target instruction architecture for the compiled binary (`'x86_64'` or `'arm64'`). |
| `output` | `string` | `'bootstrap.zip'` | Destination file path for the deployable Lambda deployment artifact. |
| `dir` | `string` | `'.'` | Working directory containing handler source code and package manifests. |
| `handler` | `string` | `'index.handler'` | Entrypoint handler signature (e.g. `'index.handler'` or `'src/app.fetch'`) resolved and bound at compile time. |
| `sourcemap` | `string` | `'false'` | Emit inline source maps into the binary for deterministic production stack traces (`'true'` or `'false'`). |
| `files` | `string` | `''` | Static assets, engines, or config glob patterns to bundle in the deployment root (YAML list format or newline-separated). |

### Outputs

| Output | Description |
| :--- | :--- |
| `path` | Absolute filesystem path to the packaged Lambda deployment zip. |
| `size` | Formatted binary size of the compiled standalone `bootstrap` executable. |
| `version` | Resolved Bun compiler version utilized during compilation. |

---

## ⚙️ AWS Lambda Configuration

To run the output artifact, configure your Lambda function with a custom runtime on Amazon Linux 2023.

### Key Settings:
- **Runtime**: `provided.al2023` (or `provided.al2`)
- **Architecture**: Match your `arch` input (`arm64` for AWS Graviton, `x86_64` for Intel/AMD)
- **Handler**: Can be any dummy string (e.g., `bootstrap` or `index.handler`) because the entrypoint is statically bound into the binary.

---

### Terraform / OpenTofu

```hcl
resource "aws_lambda_function" "bun_api" {
  function_name    = "bun-lambda-service"
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "provided.al2023"
  architectures    = ["arm64"]
  handler          = "bootstrap"
  filename         = "dist/bootstrap.zip"
  source_code_hash = filebase64sha256("dist/bootstrap.zip")
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      NODE_ENV = "production"
    }
  }
}
```

### AWS CDK (TypeScript)

```typescript
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";

new lambda.Function(this, "BunLambdaFunction", {
  runtime: lambda.Runtime.PROVIDED_AL2023,
  architecture: lambda.Architecture.ARM_64,
  handler: "bootstrap",
  code: lambda.Code.fromAsset(path.join(__dirname, "../dist/bootstrap.zip")),
  memorySize: 256,
  timeout: cdk.Duration.seconds(10),
});
```

### Serverless Framework

```yaml
service: bun-service
provider:
  name: aws
  runtime: provided.al2023
  architecture: arm64

functions:
  api:
    handler: bootstrap
    package:
      artifact: dist/bootstrap.zip
```

### AWS SAM

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  BunFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: provided.al2023
      Architectures:
        - arm64
      Handler: bootstrap
      CodeUri: dist/bootstrap.zip
      MemorySize: 256
      Timeout: 10
```

---

## 🛠️ Production Recipes

### Full CI/CD with AWS OIDC Deployment

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Standalone Bun Lambda Binary
        id: build
        uses: dev-swarup/bun-lambda@v1
        with:
          bun-version: 'latest'
          arch: 'arm64'
          dir: '.'
          handler: 'src/handler.handler'
          output: 'build/function.zip'

      - name: Authenticate to AWS via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-lambda-deployer
          aws-region: us-east-1

      - name: Update Lambda Function Code
        run: |
          aws lambda update-function-code \
            --function-name my-production-service \
            --zip-file fileb://${{ steps.build.outputs.path }}
```

### Bundling External Static Files & Prisma Engines

When using ORMs (like Prisma) or templates that load files dynamically from the filesystem at runtime:

```yaml
- uses: dev-swarup/bun-lambda@v1
  with:
    arch: 'arm64'
    dir: '.'
    handler: 'src/server.handler'
    files: |
      - prisma/schema.prisma
      - node_modules/.prisma/client/libquery_engine-*.so.node
      - templates/**/*.html
      - config/*.json
```

### Enabling Inline Source Maps for Production Debugging

```yaml
- uses: dev-swarup/bun-lambda@v1
  with:
    arch: 'arm64'
    dir: '.'
    handler: 'src/index.handler'
    sourcemap: 'true'
```

---

## ⚖️ Performance & Operational Considerations

1. **Memory & CPU Allocation**:
   - AWS Lambda allocates CPU proportionally to configured RAM.
   - For maximum initialization and compute throughput, test your function at **256 MB – 1024 MB**.

2. **Filesystem Read-Only Sandbox**:
   - AWS Lambda mounts `/var/task` as read-only.
   - If your application writes temporary files or caches, write them to `/tmp` (which provides between 512 MB and 10 GB of ephemeral storage).

3. **Compiled Binary Footprint**:
   - The compiled `bootstrap` binary embeds the JavaScriptCore engine along with your compiled bytecode, resulting in an executable size typically between **45 MB – 85 MB** (compressed zip ~25–40 MB).
   - Because execution is native and uncompressed in memory, cold start initialization is measured in single-digit to low double-digit milliseconds.

4. **Native Node Addons (`.node`)**:
   - C++ / Rust `.node` binary addons cannot be compiled directly into the monolithic executable. Include them via the `files` parameter so they are placed in the zip alongside `bootstrap`.

---

## 📄 License

Distributed under the MIT License. See [LICENSE](./LICENSE) for details.

Developed with ❤️ by [dev-swarup](https://github.com/dev-swarup).
