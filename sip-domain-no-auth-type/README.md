# a SIP Domain with no auth_type accepts no traffic at all

The domain exists. It has a name, it has a voice_url, it appears in the console alongside the ones that work, and it rejects every call. Not with a 500, not with a TwiML error, not with anything your application can see &mdash; the INVITE is refused at authentication, which happens before Twilio ever looks at the URL you configured. The domain looks provisioned because provisioning it and making it able to accept traffic are two different operations.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sip-domain-no-auth-type/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sip_domain_auth_audit.py
node node/twilio-sip-domain-auth-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sip_domain_auth_audit.py
node --test node/twilio-sip-domain-auth-audit.test.mjs
```
