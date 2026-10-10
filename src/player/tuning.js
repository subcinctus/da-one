// Feel/tuning constants for the player, camera and interaction. Tweak here, not in the logic.

/** On-foot movement (m, s). */
export const MOVE = {
  walk: 4.3,
  sprint: 7.5,
  crouch: 1.8,
  aimWalk: 3.1,           // GTA-style slower walk while aiming
  swim: 2.7,
  swimFast: 4.0,
  fly: 10.9,
  flyFast: 21.6,
  accelGround: 42,        // m/s^2 toward the target velocity
  decelGround: 34,        // friction when no input
  accelAir: 9,            // air control
  accelWater: 10,
  jumpHeight: 1.25,       // blocks
  coyoteTime: 0.12,
  jumpBuffer: 0.15,
  autoJumpRepeat: 0.28,   // holding Space re-jumps after landing
  stepSmooth: 13,         // camera/model catch-up rate after an auto-step
  fallSafe: 4,            // blocks without damage
  fallDamagePerBlock: 8,
  breathTime: 15,         // seconds of air with the head under water
  drownDps: 5,
  regenDelay: 8,          // seconds without damage before regeneration
  regenCap: 0.5,          // fraction of maxHealth
  regenRate: 2.5,         // hp / s
  turnRate: 11,           // body yaw toward movement direction (third person)
  turnRateAim: 24,        // body yaw toward the camera (aiming / first person / acting)
  stride: 1.95,           // metres between footsteps (walking)
  strideSprint: 2.5,
  strideCrouch: 1.3,
  respawnDelay: 4.5,
  hospitalBill: 100,
  respawnInvuln: 2.0,
};

/** Interaction (mining / building / punching). */
export const INTERACT = {
  reach: 5,               // metres from the eye to the targeted block face
  punchRange: 2.6,
  punchCooldown: 0.4,
  placeRepeat: 0.25,
  breakCooldown: 0.18,    // pause between consecutive breaks while holding LMB
  hitSoundInterval: 0.24,
  swingInterval: 0.27,
};

/** Camera rig. */
export const CAM = {
  eye: 1.62,
  crouchDrop: 0.3,
  third: { dist: 4.0, offset: 0.55, height: 1.72 },
  far: { dist: 8.0, offset: 0.0, height: 2.3 },
  aim: { dist: 2.4, offset: 0.75, height: 1.74 },
  /** fraction of the weapon zoom applied in third person (full zoom in first person / scopes) */
  thirdPersonZoom: 0.45,
  minDist: 0.5,
  sprintFovKick: 6,
  vehicleFovKick: 12,
  carDist: 7,
  carHeight: 2.5,
  heliDist: 14,
  heliHeight: 5.5,
  recentreDelay: 1.5,
  titleRadius: 44,       // fog ends at ~90 m: keep the orbit target well inside it
  titleHeight: 28,
  titleSpeed: 0.045,
};
