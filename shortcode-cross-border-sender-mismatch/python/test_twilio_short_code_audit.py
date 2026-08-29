from twilio_short_code_audit import dial_code, is_short_code, tally, verdict


def make(sender, to, code=None, service="MG1", direction="outbound-api", sid="SM1"):
    return {"from": sender, "to": to, "error_code": code, "sid": sid,
            "messaging_service_sid": service, "direction": direction}


def pool(**over):
    p = {"short_codes": ["12345"], "long_codes": 2, "alpha_senders": 0,
         "total": 0, "blocked": 0, "destinations": {}}
    p.update(over)
    return p


def test_short_code_already_rejected_abroad():
    row = tally([make("12345", "+14165550123", 21612)])["MG1"]
    state, detail = verdict(pool(**{k: v for k, v in row.items() if k != "service"}))
    assert state == "blocked"
    assert "21612" in detail


def test_mixed_pool_with_foreign_traffic_is_exposed_before_it_fails():
    row = tally([make("+12025550123", "+447700900123"),
                 make("+12025550123", "+12025550124")])["MG1"]
    state, detail = verdict(pool(**{k: v for k, v in row.items() if k != "service"}))
    assert state == "exposed"
    assert "per message" in detail


def test_pool_of_short_codes_only_cannot_reach_abroad_at_all():
    row = tally([make("12345", "+447700900123")])["MG1"]
    state, detail = verdict(pool(long_codes=0, alpha_senders=0,
                                 **{k: v for k, v in row.items() if k != "service"}))
    assert state == "unreachable-abroad"
    assert "request time" in detail


def test_domestic_only_traffic_is_not_a_finding():
    row = tally([make("12345", "+12025550123")])["MG1"]
    state, _ = verdict(pool(**{k: v for k, v in row.items() if k != "service"}))
    assert state == "domestic-only"


def test_service_with_no_short_code_is_skipped():
    assert verdict(pool(short_codes=[], destinations={"44": 5}))[0] == "no-short-code"


def test_21606_from_a_long_code_is_not_counted_as_this_problem():
    # Same error code, different fault: a voice-only long code fails everywhere.
    row = tally([make("+12025550123", "+14165550123", 21606)])["MG1"]
    assert row["blocked"] == 0


def test_home_country_is_an_argument_because_the_resource_has_no_country():
    row = tally([make("12345", "+447700900123")])["MG1"]
    stats = {k: v for k, v in row.items() if k != "service"}
    assert verdict(pool(**stats), home="1")[0] == "exposed"
    assert verdict(pool(**stats), home="44")[0] == "domestic-only"


def test_the_border_inside_plus_one_is_only_visible_in_the_rejections():
    # A US short code cannot reach a Canadian handset, but both share calling
    # code 1, so the destination count cannot see it and only the 21612 does.
    quiet = tally([make("12345", "+14165550123")])["MG1"]
    assert verdict(pool(**{k: v for k, v in quiet.items() if k != "service"}))[0] ==         "domestic-only"
    loud = tally([make("12345", "+14165550123", 21612)])["MG1"]
    assert verdict(pool(**{k: v for k, v in loud.items() if k != "service"}))[0] ==         "blocked"


def test_short_code_and_dial_code_helpers():
    assert is_short_code("12345")
    assert not is_short_code("+12025550123")
    assert not is_short_code("MyBrand")
    assert dial_code("+447700900123") == "44"
