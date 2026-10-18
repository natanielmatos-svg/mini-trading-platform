const fs=require('node:fs');fs.writeFileSync('_local/deploy-residual.cjs',fs.readFileSync('_local/deploy-calibration-trial.cjs','utf8').replaceAll('6904','15740').replaceAll('calibration-trial','market-residual'));
fs.writeFileSync('_local/check-residual.cjs',fs.readFileSync('_local/check-calibration-trial.cjs','utf8').replaceAll('midpointCalibrationTrial','marketResidualTrial'));
