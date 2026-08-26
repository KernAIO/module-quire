/**
 * The slice of core's API quire reaches for, named by shape.
 *
 * A `person` column stores user ids, so a database cell has to turn one into a face and a name.
 * Typing the seam structurally keeps the dependency pointing one way: quire does not import core's
 * router type, and core does not know quire exists.
 */
export interface CoreMember {
  userId: string
  user: {
    id: string
    name: string | null
    email: string
    avatarUrl?: string | null
  }
}

export interface CoreApi {
  workspaces: {
    members: {
      list(input: { workspaceId: string; limit?: number }): Promise<{ items: CoreMember[] }>
    }
  }
}

/** A person as this module's cells and menus want them. */
export interface Person {
  id: string
  name: string
  avatarUrl: string | null
}

/** A member with no display name still has to be pickable, so the address stands in for the name. */
export const toPerson = (member: CoreMember): Person => ({
  id: member.user.id,
  name: member.user.name ?? member.user.email,
  avatarUrl: member.user.avatarUrl ?? null,
})
