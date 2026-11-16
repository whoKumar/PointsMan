# <Feature> — API contract

**Status:** draft · **Date:** <YYYY-MM-DD> · **Owner (this side):** <you> ·
**Owner (other side):** <backend/service owner>

> Agree this *before* any client code is wired. The client follows this doc, not a
> guess. Changes to a shipped field are additive (add a new optional field; keep
> the old one working until both sides migrate).

## The request
```
<METHOD> /path/to/endpoint
Auth: <what token / none>
Query / body: { ... }
```

## The response
```jsonc
{
  "success": true,
  "data": {
    // exact field names + types the client will read
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `example` | string | ✅ | what it means, example value |

## Errors
| Status | When | What the client does |
|--------|------|----------------------|
| 4xx | ... | ... |

## Open questions to confirm
1.
2.
