package account

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestConcurrentAdministratorRemovalsKeepOneEnabledAndAuditOnlySuccess(t *testing.T) {
	for _, first := range []string{"demote", "disable", "delete"} {
		for _, second := range []string{"demote", "disable", "delete"} {
			t.Run(first+"/"+second, func(t *testing.T) {
				store := openEmptyAccountTestStore(t)
				if _, err := store.db.Exec(`INSERT INTO user_account(id,username,role,enabled) VALUES
					(1,'synthetic-admin-a','super_admin',1),(2,'synthetic-admin-b','super_admin',1)`); err != nil {
					t.Fatal(err)
				}
				start := make(chan struct{})
				results := make(chan error, 2)
				var workers sync.WaitGroup
				for index, action := range []string{first, second} {
					workers.Go(func() {
						<-start
						id := int64(index + 1)
						if action == "delete" {
							results <- store.DeleteManagedUser(context.Background(), 0, id)
							return
						}
						input := UpdateUserInput{ID: id, DisplayName: "Example Admin", Role: "super_admin", Enabled: true}
						if action == "demote" {
							input.Role = "user"
						} else {
							input.Enabled = false
						}
						_, err := store.UpdateManagedUser(context.Background(), input)
						results <- err
					})
				}
				close(start)
				workers.Wait()
				close(results)
				succeeded, rejected := 0, 0
				for err := range results {
					if err == nil {
						succeeded++
					} else if errors.Is(err, ErrLastSuperAdmin) {
						rejected++
					} else {
						t.Fatal(err)
					}
				}
				var enabled, audits int
				if err := store.db.QueryRow("SELECT COUNT(*) FROM user_account WHERE role = 'super_admin' AND enabled = 1").Scan(&enabled); err != nil {
					t.Fatal(err)
				}
				if err := store.db.QueryRow("SELECT COUNT(*) FROM audit_log WHERE action IN ('user.update','user.delete')").Scan(&audits); err != nil {
					t.Fatal(err)
				}
				if enabled != 1 || audits != 1 || succeeded != 1 || rejected != 1 {
					t.Fatalf("enabled/audits/succeeded/rejected = %d/%d/%d/%d", enabled, audits, succeeded, rejected)
				}
			})
		}
	}
}

func TestManagedPatchUsesCurrentFieldsAndPreservesEnvironmentPolicy(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	if _, err := store.db.Exec(`INSERT INTO user_account(id,username,role,enabled) VALUES
		(1,'synthetic-admin','super_admin',1),(2,'synthetic-target','user',1)`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	policy := ManagedUserPolicy{ActorUserID: 1, EnvironmentManagedUsername: "synthetic-admin"}
	role := "admin"
	if _, err := store.PatchManagedUser(ctx, 2, ManagedUserPatch{Role: &role}, policy); err != nil {
		t.Fatal(err)
	}
	display := "Example Renamed User"
	updated, err := store.PatchManagedUser(ctx, 2, ManagedUserPatch{DisplayName: &display}, policy)
	if err != nil || updated.Role != "admin" {
		t.Fatalf("partial patch lost current role: %+v, %v", updated, err)
	}
	disabled := false
	if _, err := store.PatchManagedUser(ctx, 1, ManagedUserPatch{Enabled: &disabled}, policy); !errors.Is(err, ErrEnvironmentManaged) {
		t.Fatalf("environment disable = %v", err)
	}
	if err := store.DeleteManagedUserWithPolicy(ctx, 1, ManagedUserPolicy{ActorUserID: 2, EnvironmentManagedUsername: "synthetic-admin"}); !errors.Is(err, ErrManagedUserForbidden) {
		t.Fatalf("administrator deleting a super admin = %v", err)
	}
	enabled := true
	super := "super_admin"
	if _, err := store.PatchManagedUser(ctx, 1, ManagedUserPatch{DisplayName: &display, Role: &super, Enabled: &enabled}, policy); err != nil {
		t.Fatalf("idempotent environment save = %v", err)
	}
	if _, err := store.db.Exec(`CREATE TRIGGER fail_user_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PatchManagedUser(ctx, 2, ManagedUserPatch{Enabled: &disabled}, policy); err == nil {
		t.Fatal("update succeeded without its audit")
	}
	target, err := store.LoadManagedUser(ctx, 2)
	if err != nil || !target.Enabled {
		t.Fatalf("audit failure did not roll back: %+v, %v", target, err)
	}
}
