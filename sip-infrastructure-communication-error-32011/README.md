# 32011: Twilio cannot reach your SIP infrastructure

Call setup gets slow, then calls stop. The trunk configuration has not been touched in months and does not need to have been: 32011 Error communicating with your SIP communications infrastructure means Twilio sent an INVITE to the address you gave it and got nothing back, or got a 5xx, or got something it could not make sense of. The change was on your side of the boundary, and it was probably a firewall rule, a TLS version, or a host that has quietly been carrying every origination URI on the trunk.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sip-infrastructure-communication-error-32011/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_trunk_origination_audit.py
node node/twilio-trunk-origination-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_trunk_origination_audit.py
node --test node/twilio-trunk-origination-audit.test.mjs
```
