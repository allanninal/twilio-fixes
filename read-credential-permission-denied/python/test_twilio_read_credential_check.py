from twilio_read_credential_check import credential_shape, verdict


def test_20003_on_the_account_read_is_a_dead_credential():
    state, detail = verdict({"account": (401, 20003)})
    assert state == "dead-credential"
    assert "Nothing else will read" in detail


def test_20003_only_on_the_main_key_resources_is_a_boundary_not_a_fault():
    state, detail = verdict({"account": (200, None), "keys": (401, 20003),
                             "accounts": (401, 20003)})
    assert state == "scoped-key"
    assert "not a broken credential" in detail


def test_a_403_with_20005_is_a_suspended_account_not_a_permission_problem():
    state, detail = verdict({"account": (403, 20005)})
    assert state == "account-not-active"
    assert "suspended" in detail


def test_a_401_without_20003_reads_as_a_stripped_header():
    state, detail = verdict({"account": (401, None)})
    assert state == "unauthenticated"
    assert "Authorization header" in detail


def test_a_different_sid_coming_back_is_a_crossed_parent_and_child():
    state, detail = verdict({"account": (200, None)},
                            requested_sid="AC1", returned_sid="AC2")
    assert state == "wrong-account"
    assert "crossed" in detail


def test_everything_readable_passes():
    state, _ = verdict({"account": (200, None), "keys": (200, None),
                        "accounts": (200, None)}, "AC1", "AC1")
    assert state == "read-ok"


def test_a_non_auth_error_is_not_reported_as_a_credential_problem():
    assert verdict({"account": (503, None)})[0] == "http-error"


def test_trailing_whitespace_is_caught_before_any_request():
    state, detail = credential_shape("AC1", "SK1", "secret\n")
    assert state == "whitespace"
    assert "TWILIO_API_SECRET" in detail


def test_an_account_sid_as_the_username_means_the_auth_token():
    state, _ = credential_shape("AC1", "AC1", "secret")
    assert state == "auth-token"


def test_a_well_formed_pair_passes_the_shape_check():
    assert credential_shape("AC1", "SK1", "secret")[0] == "ok"
