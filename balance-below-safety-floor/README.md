# the balance is one busy hour from a 20005 suspension

The account had ninety dollars on it, which had been plenty for eight months. Then a product launch put four times the usual traffic through it in one evening, the balance crossed zero somewhere around nine o'clock, and every send after that came back 20005. Nobody had done anything wrong. The number in Balance.json had simply stopped being large enough, and nothing in the system's job was to notice that.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/balance-below-safety-floor/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_balance_runway.py
node node/twilio-balance-runway.mjs
```

## Test it

```bash
pytest python/test_twilio_balance_runway.py
node --test node/twilio-balance-runway.test.mjs
```
