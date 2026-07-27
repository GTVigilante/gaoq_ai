import type {
  AlumniCleanupProof,
  AlumniCleanupTask,
} from '../domain/index.js';

/** 下游只接收授权终止最小控制面，不接收 Person、联系方式、授权证据或 ERP Token。 */
export abstract class CareAlumniCleanupPort {
  abstract execute(task: AlumniCleanupTask): Promise<AlumniCleanupProof>;
}
