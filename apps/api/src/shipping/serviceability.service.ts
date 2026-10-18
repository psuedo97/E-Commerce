import { Injectable } from '@nestjs/common';

export interface Serviceability {
  pincode: string;
  serviceable: boolean;
}

/**
 * Can we deliver to this pincode? For now everything is deliverable except pincodes listed in
 * UNSERVICEABLE_PINCODES (comma separated). When a courier is chosen (Phase 7), replace the body of
 * check() with that courier's serviceability API; callers do not change.
 */
@Injectable()
export class ServiceabilityService {
  async check(pincode: string): Promise<Serviceability> {
    const blocked = (process.env.UNSERVICEABLE_PINCODES ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return { pincode, serviceable: !blocked.includes(pincode) };
  }
}
