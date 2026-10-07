package account

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

type ManagedUserPatch struct {
	DisplayName *string
	Role        *string
	Password    *string
	Enabled     *bool
}

type ManagedUserPolicy struct {
	ActorUserID                int64
	EnvironmentManagedUsername string
}

var (
	ErrManagedUserForbidden = errors.New("account management is not permitted")
	ErrEnvironmentManaged   = errors.New("the environment-managed administrator's role, password and enabled state cannot be changed or deleted")
	ErrDeleteOwnAccount     = errors.New("you cannot delete your own account")
)

// Target state, permission-sensitive fields, the last-administrator invariant,
// mutation and audit all use the same immediate SQLite write transaction.
func (s *Store) PatchManagedUser(ctx context.Context, id int64, patch ManagedUserPatch, policy ManagedUserPolicy) (ManagedUser, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ManagedUser{}, err
	}
	defer func() { _ = tx.Rollback() }()
	current, err := loadManagedUser(ctx, tx, id)
	if err != nil {
		return ManagedUser{}, err
	}
	actor, err := managedMutationActor(ctx, tx, policy.ActorUserID, current)
	if err != nil {
		return ManagedUser{}, err
	}
	input := UpdateUserInput{ID: id, DisplayName: current.DisplayName, Role: current.Role, Enabled: current.Enabled, ActorUserID: actor.ID}
	if patch.DisplayName != nil {
		input.DisplayName = strings.TrimSpace(*patch.DisplayName)
		if input.DisplayName == "" {
			input.DisplayName = current.Username
		}
	}
	if patch.Role != nil {
		input.Role = strings.TrimSpace(*patch.Role)
	}
	if patch.Password != nil {
		input.Password = *patch.Password
	}
	if patch.Enabled != nil {
		input.Enabled = *patch.Enabled
	}
	if current.Username == policy.EnvironmentManagedUsername && (input.Role != current.Role || input.Enabled != current.Enabled || input.Password != "") {
		return ManagedUser{}, ErrEnvironmentManaged
	}
	if err := ValidateUserWrite(actor, input.Role, input.Password, false); err != nil {
		return ManagedUser{}, err
	}
	if err := preserveEnabledSuperAdmin(ctx, tx, current, input.Role, input.Enabled); err != nil {
		return ManagedUser{}, err
	}
	return s.commitManagedUserUpdate(ctx, tx, input)
}

func (s *Store) DeleteManagedUserWithPolicy(ctx context.Context, id int64, policy ManagedUserPolicy) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	current, err := loadManagedUser(ctx, tx, id)
	if err != nil {
		return err
	}
	if _, err := managedMutationActor(ctx, tx, policy.ActorUserID, current); err != nil {
		return err
	}
	if policy.ActorUserID == id {
		return ErrDeleteOwnAccount
	}
	if current.Username == policy.EnvironmentManagedUsername {
		return ErrEnvironmentManaged
	}
	if err := preserveEnabledSuperAdmin(ctx, tx, current, "", false); err != nil {
		return err
	}
	return deleteManagedUserTx(ctx, tx, policy.ActorUserID, id)
}

func managedMutationActor(ctx context.Context, tx *sql.Tx, id int64, target ManagedUser) (User, error) {
	actor, err := loadManagedUser(ctx, tx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrManagedUserForbidden
		}
		return User{}, err
	}
	if !actor.Enabled || (actor.Role != "super_admin" && (actor.Role != "admin" || target.Role == "super_admin")) {
		return User{}, ErrManagedUserForbidden
	}
	return User{ID: actor.ID, Role: actor.Role}, nil
}
